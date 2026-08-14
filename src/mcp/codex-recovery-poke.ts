import type { CodexPanePreRegRepo } from './codex-pane-pre-register-repo.js'
import type { AcceptedPreRegRow } from './pre-register-codex-pane.js'
import type { IdentityKeyMatch } from '../storage/agents-repo.js'
import {
  classifyCodexCarrier,
  defaultForegroundProbeSync,
  type CarrierMatchCollapse,
  type PaneTtyEntry,
} from './auto-bind-codex-pane.js'
import {
  detectCodexCarrier,
  type DetectedCodexCarrier,
} from './codex-carrier-detect.js'
import { pokeWroteContent, tmuxPokeImpl } from './poke.js'
import type { TmuxPokeResult } from './transport-dispatch.js'
import { runQuietGuard } from './poke-guard.js'
import {
  loadTmuxPaneSnapshot,
  verifyPaneHost,
  type PaneHostVerdict,
} from './pane-host-verify.js'
import { isAlive } from '../daemon/pid.js'
import {
  clearCodexRecoveryNoncesForPane,
  markCodexRecoveryNonceDelivered,
  mintCodexRecoveryNonce,
} from './codex-recovery-nonce.js'
import { describeRedactedError } from './log-redact.js'

export const RECOVERY_PROBE_INTERVAL_MS = 5_000

export interface CodexRecoveryDeps {
  repo: CodexPanePreRegRepo
  findByIdentityKey: (key: string) => IdentityKeyMatch[]
  findByDeclaredIdentity: (
    team: string,
    name: string
  ) => IdentityKeyMatch | undefined
  localDevice: string
  isProcessAlive?: (pid: number) => boolean
  listPanes?: () => Promise<PaneTtyEntry[]>
  ttyProcesses?: (tty: string) => Promise<string[]>
  /** Synchronous ps against the pane tty for the write-time carrier proof.
   *  Tests MUST inject this: the default shells out to real `ps`. */
  foregroundProbeSync?: (tty: string) => string[]
  now?: () => Date
  probeIntervalMs?: number
  tmuxPoke?: (args: {
    pane_id: string
    content: string
    skipGuard?: boolean
    confirmOwnership?: () => boolean
  }) => Promise<TmuxPokeResult>
  verifyPaneHost?: (args: {
    paneId: string
    pid: number
    holderAgentId: string | null
    stillCurrent: () => boolean
  }) => Promise<PaneHostVerdict>
  paneGuard?: (paneId: string) => Promise<'pass' | 'fail'>
  log?: (line: string) => void
}

interface RecoveryScheduleEntry {
  timer?: ReturnType<typeof setTimeout>
  cancelled: boolean
  /** Generation token; unique per schedule, never reused. */
  messageId: string
}

// Module-level like poke-retry's retryMap: registerBusinessTools runs once per
// MCP session, so per-instance state could not see cancellations that arrive
// on another session (overwrite or auto-bind consumption).
const recoverySchedules = new Map<string, RecoveryScheduleEntry>()
// Generation authority per pane. The schedule entry leaves recoverySchedules
// when the send begins, but the in-flight send lives on; this map keeps the
// current generation's token addressable so combined cancel (consumption /
// overwrite / shutdown) makes exactly that send abort at its next checkpoint.
const currentGenerationMessageId = new Map<string, string>()
let recoveryGeneration = 0

function nowIso(deps: CodexRecoveryDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString()
}

/** Every recovery log line carries an ISO timestamp; the daemon sink itself
 *  does not add one.  Redaction rules apply upstream: never key values,
 *  never argv contents. */
function rlog(deps: CodexRecoveryDeps, line: string): void {
  deps.log?.(`[${nowIso(deps)}] ${line}`)
}

/**
 * Recovery poke wording. Deliberately never includes the identity_key value:
 * the poke lands in the codex conversation context, and the key must never
 * appear on any process argv or in model context — the CLI reads the
 * launcher-exported environment variable and forwards it only over the
 * authenticated HTTP channel.
 */
export function buildCodexRecoveryPokeContent(
  args: { team: string; name: string; nonce?: string }
): string {
  return [
    '[cross-agent-teams recovery notice]',
    `This pane was previously registered on cross-agent-teams (xats) as`,
    `name="${args.name}" team="${args.team}" and appears to have been restarted.`,
    'Please re-register now: call the cross-agent-teams MCP tool register_agent',
    `with {agent_type: "codex", name: "${args.name}", team: "${args.team}",`,
    'thread_id: <value of $CODEX_THREAD_ID>,',
    'project_dir: <your current working directory>',
    // The daemon sent this notice to ONE pane, so quoting the token back is
    // what tells it which pane the caller is — the caller cannot work that out
    // for itself (its tools run in a shared app-server, where $TMUX_PANE is
    // some other pane's id).  Kept last and phrased as a plain copy so a model
    // that skips reasoning about it still passes it through.
    ...(args.nonce === undefined
      ? []
      : [`, recovery_nonce: "${args.nonce}"} (copy that value exactly).`]),
    ...(args.nonce === undefined ? ['}.'] : []),
  ].join(' ')
}

/** Generation token: unique per schedule generation, never reused. */
export function recoveryRetryMessageId(
  paneId: string,
  generation: number
): string {
  return `codex-recovery:${paneId}:${generation}`
}

export interface RecoveryCancelOptions {
  /** Terminal-cancellation reason ('row_consumed', 'row_replaced',
   *  'daemon_shutdown', ...).  Logged only when a live schedule or an
   *  in-flight generation was actually cancelled AND a log sink is given;
   *  the line never contains key values. */
  reason?: string
  log?: (line: string) => void
  now?: () => Date
}

export function cancelCodexRecoverySchedule(
  paneId: string,
  opts: RecoveryCancelOptions = {}
): void {
  const entry = recoverySchedules.get(paneId)
  const hadGeneration = currentGenerationMessageId.has(paneId)
  if (entry) {
    entry.cancelled = true
    if (entry.timer) clearTimeout(entry.timer)
    recoverySchedules.delete(paneId)
  }
  // A send that already left the schedule map may still be in flight;
  // retiring the pane's generation token makes it abort at its next
  // cancellation checkpoint (every await boundary re-checks it).
  currentGenerationMessageId.delete(paneId)
  // The token belongs to the schedule: once the row is consumed, replaced or
  // expired, a surviving nonce would still point at this pane.
  clearCodexRecoveryNoncesForPane(paneId)
  // Active cancellations (consumption/overwrite/shutdown) log their terminal
  // reason here; the cancelled closure itself stays silent (generationActive
  // is already false), so exactly one line records why the generation ended.
  if ((entry !== undefined || hadGeneration) && opts.reason && opts.log) {
    const iso = (opts.now ?? (() => new Date()))().toISOString()
    opts.log(
      `[${iso}] codex-recovery cancelled: pane=${paneId} reason=${opts.reason}`
    )
  }
}

export function clearAllCodexRecoverySchedules(
  opts: RecoveryCancelOptions = {}
): void {
  const panes = new Set([
    ...recoverySchedules.keys(),
    ...currentGenerationMessageId.keys(),
  ])
  for (const paneId of panes) cancelCodexRecoverySchedule(paneId, opts)
}

export function __peekCodexRecoverySchedules(): string[] {
  return Array.from(recoverySchedules.keys())
}

/**
 * Whether the pane currently holds a live recovery generation.  Read by the
 * seeding trigger: a pane holds at most ONE live token, and the recovery one
 * stands because it carries strictly more (it names the identity to register
 * as).  The generation map, not the schedule map, is the authority — a send
 * that has already left the schedule map is still live.
 */
export function hasLiveCodexRecoverySchedule(paneId: string): boolean {
  return currentGenerationMessageId.has(paneId)
}

export function __peekCodexRecoveryGenerations(): Map<string, string> {
  return new Map(currentGenerationMessageId)
}

/**
 * Called after every accepted pre_register_codex_pane. Always cancels any
 * schedule the pane already had (same-pane overwrite semantics), then decides
 * from the new row alone whether a recovery poke should be scheduled.
 */
export function evaluateCodexRecoveryOnPreRegister(
  row: AcceptedPreRegRow,
  deps: CodexRecoveryDeps
): void {
  cancelCodexRecoverySchedule(row.pane_id, {
    reason: 'row_replaced',
    log: deps.log,
    now: deps.now,
  })
  const resolved = resolveScheduleIdentity(row, deps)
  if (resolved === undefined) return

  recoveryGeneration += 1
  const messageId = recoveryRetryMessageId(row.pane_id, recoveryGeneration)
  const entry: RecoveryScheduleEntry = { cancelled: false, messageId }
  recoverySchedules.set(row.pane_id, entry)
  currentGenerationMessageId.set(row.pane_id, messageId)
  const state: ProbeState = {
    entry,
    row,
    source: resolved.source,
    holder: resolved.holder,
    deps,
    probeErrorLogged: new Set(),
    resumeLogged: new Set(),
    detectedPidsLogged: new Set(),
  }
  rlog(deps,
    `codex-recovery scheduled: pane=${row.pane_id} ` +
    `identity=(${resolved.holder.team}, ${resolved.holder.name}) ` +
    `source=${resolved.source}`
  )
  // First probe fires immediately (delay 0): the codex process may already be
  // up by the time the pre-register call lands.
  entry.timer = setTimeout(() => { void probeIteration(state) }, 0)
}

type RecoveryIdentitySource = 'key' | 'declaration'

interface RecoveryIdentity {
  agent_id: string | null
  team: string
  name: string
}

function holderIsAlive(
  holder: IdentityKeyMatch,
  deps: CodexRecoveryDeps
): boolean {
  const pid = holder.runtime_ui_pid
  return pid !== null && pid > 0 && (deps.isProcessAlive ?? isAlive)(pid)
}

type DeclaredHolderRefusal =
  | 'holder_alive'
  | 'holder_liveness_unknown'

const HOLDER_LIVENESS_UNKNOWN_CONSEQUENCE =
  'consequence=will_not_auto_recover_until_identity_registers_with_positive_pid'

function holderRefusalLogSuffix(reason: string | undefined): string {
  return reason === 'holder_liveness_unknown'
    ? ` ${HOLDER_LIVENESS_UNKNOWN_CONSEQUENCE}`
    : ''
}

function declaredHolderRefusal(
  holder: IdentityKeyMatch,
  deps: CodexRecoveryDeps
): DeclaredHolderRefusal | undefined {
  const pid = holder.runtime_ui_pid
  if (pid === null || pid <= 0) return 'holder_liveness_unknown'
  return (deps.isProcessAlive ?? isAlive)(pid) ? 'holder_alive' : undefined
}

function logDeclarationConflict(
  row: AcceptedPreRegRow,
  holder: IdentityKeyMatch,
  deps: CodexRecoveryDeps
): void {
  if (row.team === undefined || row.team === null) return
  if (row.agent_name === undefined || row.agent_name === null) return
  if (row.team === holder.team && row.agent_name === holder.name) return
  rlog(deps,
    `codex-recovery declaration conflict (debug): pane=${row.pane_id} ` +
    `key_identity=(${holder.team}, ${holder.name}) ` +
    `declared_identity=(${row.team}, ${row.agent_name})`
  )
}

function resolveDeclaredScheduleIdentity(
  row: AcceptedPreRegRow,
  deps: CodexRecoveryDeps
): RecoveryIdentity | undefined {
  const hasTeam = row.team !== undefined && row.team !== null
  const hasName = row.agent_name !== undefined && row.agent_name !== null
  if (hasTeam !== hasName) {
    rlog(deps,
      `codex-recovery skip (debug): pane=${row.pane_id} ` +
      'reason=incomplete_declaration'
    )
    return undefined
  }
  if (!hasTeam || !hasName) return undefined

  const team = row.team as string
  const name = row.agent_name as string
  const holder = deps.findByDeclaredIdentity(team, name)
  const refusal = holder === undefined
    ? undefined
    : declaredHolderRefusal(holder, deps)
  if (holder !== undefined && refusal !== undefined) {
    rlog(deps,
      `codex-recovery skip: pane=${row.pane_id} ` +
      `reason=${refusal}` +
      holderRefusalLogSuffix(refusal) + ' ' +
      `declared_identity=(${team}, ${name}) ` +
      `current_holder=${holder.agent_id} ` +
      `runtime_ui_pid=${holder.runtime_ui_pid}`
    )
    return undefined
  }
  return {
    agent_id: holder?.agent_id ?? null,
    team,
    name,
  }
}

function resolveScheduleIdentity(
  row: AcceptedPreRegRow,
  deps: CodexRecoveryDeps
): { source: RecoveryIdentitySource; holder: RecoveryIdentity } | undefined {
  if (row.identity_key !== null) {
    const holder = deps.findByIdentityKey(row.identity_key)[0]
    if (holder !== undefined) {
      logDeclarationConflict(row, holder, deps)
      if (holderIsAlive(holder, deps)) {
        rlog(deps,
          `codex-recovery skip: holder (${holder.team}, ${holder.name}) ` +
          `runtime_ui_pid=${holder.runtime_ui_pid} is alive; ` +
          `pane=${row.pane_id}`
        )
        return undefined
      }
      return { source: 'key', holder }
    }
  }
  const holder = resolveDeclaredScheduleIdentity(row, deps)
  return holder === undefined
    ? undefined
    : { source: 'declaration', holder }
}

interface ProbeState {
  entry: RecoveryScheduleEntry
  row: AcceptedPreRegRow
  source: RecoveryIdentitySource
  /** Identity captured at schedule time. Every probe/send re-resolves it
   *  through the schedule's source before acting. */
  holder: RecoveryIdentity
  deps: CodexRecoveryDeps
  /** Probe stages whose infrastructure error was already logged (once each). */
  probeErrorLogged: Set<string>
  /** Transient-resume reasons already logged for the current consecutive
   *  streak; a reason is cleared when its stage passes again, so every
   *  streak logs exactly once (bounded, instead of one line per probe
   *  interval while the pane stays in the same state). */
  resumeLogged: Set<TransientReason>
  /** Pids whose detection line was already logged this generation (once per
   *  distinct pid, even across an A→B→A flip-flop). */
  detectedPidsLogged: Set<number>
}

type TransientReason = 'guard_failed' | 'carrier_backgrounded'

/**
 * A closure belongs to the live generation only while its messageId is still
 * the pane's registered one. Cancellation, overwrite, and shutdown all retire
 * the messageId, so every stale closure observes its own retirement without
 * scanning by pane prefix — it can never act on a newer generation.
 */
function generationActive(state: ProbeState): boolean {
  return !state.entry.cancelled
    && currentGenerationMessageId.get(state.row.pane_id)
      === state.entry.messageId
}

/** Generation-scoped cancel used from inside a probe/send closure: it may
 *  only retire itself, never a newer generation that replaced it. */
function cancelOwnGeneration(state: ProbeState): void {
  const { entry, row } = state
  entry.cancelled = true
  if (entry.timer) clearTimeout(entry.timer)
  if (recoverySchedules.get(row.pane_id) === entry) {
    recoverySchedules.delete(row.pane_id)
  }
  if (currentGenerationMessageId.get(row.pane_id) === entry.messageId) {
    currentGenerationMessageId.delete(row.pane_id)
  }
}

function rowStillCurrent(state: ProbeState): boolean {
  const now = nowIso(state.deps)
  const current = state.deps.repo.getByPaneId(state.row.pane_id)
  // Full-snapshot equality: a same-value overwrite with a refreshed expiry is
  // a new generation and must not keep this schedule's sends alive.
  return current !== undefined
    && current.xats_agent_id === state.row.xats_agent_id
    && current.identity_key === state.row.identity_key
    && current.expires_at === state.row.expires_at
    && current.expires_at > now
}

/** Terminal-cancellation reason for a row that failed rowStillCurrent. */
function rowGoneReason(state: ProbeState): string {
  const current = state.deps.repo.getByPaneId(state.row.pane_id)
  if (current === undefined) return 'row_consumed'
  if (
    current.xats_agent_id !== state.row.xats_agent_id
    || current.identity_key !== state.row.identity_key
    || current.expires_at !== state.row.expires_at
  ) {
    return 'row_replaced'
  }
  return 'row_expired'
}

type HolderSkipReason =
  | 'holder_missing'
  | 'holder_changed'
  | 'holder_alive'
  | 'holder_liveness_unknown'

type HolderResolution =
  | { holder: RecoveryIdentity }
  | { skip: HolderSkipReason }

function resolveCurrentHolder(state: ProbeState): HolderResolution {
  const { row, deps } = state
  if (state.source === 'declaration') {
    const holder = deps.findByDeclaredIdentity(
      state.holder.team,
      state.holder.name
    )
    if (holder === undefined) {
      return {
        holder: {
          agent_id: null,
          team: state.holder.team,
          name: state.holder.name,
        },
      }
    }
    const refusal = declaredHolderRefusal(holder, deps)
    if (refusal !== undefined) return { skip: refusal }
    return {
      holder: {
        agent_id: holder.agent_id,
        team: holder.team,
        name: holder.name,
      },
    }
  }
  if (row.identity_key === null) return { skip: 'holder_missing' }
  const holder = deps.findByIdentityKey(row.identity_key)[0]
  if (holder === undefined) return { skip: 'holder_missing' }
  if (
    holder.agent_id !== state.holder.agent_id
    || holder.team !== state.holder.team
    || holder.name !== state.holder.name
  ) {
    return { skip: 'holder_changed' }
  }
  if (holderIsAlive(holder, deps)) return { skip: 'holder_alive' }
  return {
    holder: { agent_id: holder.agent_id, team: holder.team, name: holder.name },
  }
}

async function probeIteration(state: ProbeState): Promise<void> {
  const { entry, row, deps } = state
  if (!generationActive(state)) return
  try {
    // The row leaving the pending state (expired, consumed, or overwritten)
    // terminates polling before any probe or send.
    if (!rowStillCurrent(state)) {
      rlog(deps,
        `codex-recovery cancelled: pane=${row.pane_id} ` +
        `reason=${rowGoneReason(state)}`
      )
      cancelOwnGeneration(state)
      return
    }
    // The holder is re-resolved every iteration: a key that moved, vanished,
    // or came back alive invalidates this schedule's reason to exist.
    const resolution = resolveCurrentHolder(state)
    if ('skip' in resolution) {
      rlog(deps,
        `codex-recovery skip: pane=${row.pane_id} ` +
        `reason=${resolution.skip}` +
        holderRefusalLogSuffix(resolution.skip)
      )
      cancelOwnGeneration(state)
      return
    }

    const detected = await detectCodexProcess(state)
    if (!generationActive(state)) return
    if (detected === undefined) {
      entry.timer = setTimeout(
        () => { void probeIteration(state) },
        deps.probeIntervalMs ?? RECOVERY_PROBE_INTERVAL_MS
      )
      return
    }
    // Once per distinct pid per generation: resumed polling re-detects the
    // same process every interval and must not repeat the line, and an
    // A→B→A pid flip-flop must not log A twice.
    if (!state.detectedPidsLogged.has(detected.pid)) {
      state.detectedPidsLogged.add(detected.pid)
      rlog(deps,
        `codex-recovery detected: pane=${row.pane_id} pid=${detected.pid}`
      )
    }

    if (recoverySchedules.get(row.pane_id) === entry) {
      recoverySchedules.delete(row.pane_id)
    }
    await sendRecoveryPoke(state, detected.pid)
  } catch (error) {
    rlog(deps,
      `codex-recovery probe error: pane=${row.pane_id} stage=iteration ` +
      `error=${describeRedactedError(error, row.identity_key)}`
    )
    cancelOwnGeneration(state)
  }
}

// A broken tmux/ps must be distinguishable from ordinary "codex not up yet"
// polling (which logs nothing), without spamming a line every interval: each
// stage logs its first infrastructure error once per schedule generation.
function logProbeStageError(
  state: ProbeState,
  stage: 'list_panes' | 'tty_processes',
  error: unknown
): void {
  if (state.probeErrorLogged.has(stage)) return
  state.probeErrorLogged.add(stage)
  rlog(state.deps,
    `codex-recovery probe degraded (debug): pane=${state.row.pane_id} ` +
    `stage=${stage} ` +
    `error=${describeRedactedError(error, state.row.identity_key)}`
  )
}

async function detectCodexProcess(
  state: ProbeState
): Promise<DetectedCodexCarrier | undefined> {
  const { row, deps } = state
  return detectCodexCarrier({
    paneId: row.pane_id,
    uuid: row.xats_agent_id,
    listPanes: deps.listPanes,
    ttyProcesses: deps.ttyProcesses,
    onStageError: (stage, error) => logProbeStageError(state, stage, error),
    onAmbiguous: collapsed => logDetectCollapseSkip(state, collapsed),
  })
}

// Multiple matching codex lines that do not collapse into one foreground
// process group (cross-pgid ambiguity, or a same-group set without a leader
// line) must be distinguishable from ordinary "codex not up yet" polling
// without spamming a line every interval: once per generation per reason.
function logDetectCollapseSkip(
  state: ProbeState,
  collapsed: CarrierMatchCollapse
): void {
  const key = `detect:${collapsed.skipReason}`
  if (state.probeErrorLogged.has(key)) return
  state.probeErrorLogged.add(key)
  rlog(state.deps,
    `codex-recovery detect skip (debug): pane=${state.row.pane_id} ` +
    `reason=${collapsed.skipReason} matches=${collapsed.matchCount} ` +
    `distinct_pgids=${collapsed.distinctPgids}`
  )
}

async function sendRecoveryPoke(state: ProbeState, pid: number): Promise<void> {
  const { row, deps } = state
  // Guard first: everything the paste depends on (codex process, row, holder,
  // pane host) is re-checked after the quiet window, so a codex exit during
  // the guard cannot ride a stale pre-guard snapshot into a shell paste.
  const guardFn = deps.paneGuard ?? runQuietGuard
  const guard = await guardFn(row.pane_id)
  // Cancellation (overwrite, consumption, shutdown) may land during the quiet
  // window; a cancelled generation neither pastes nor resumes polling.
  if (!generationActive(state)) return
  if (guard === 'fail') {
    // A failing quiet guard right after a codex restart is the common
    // transient case (the TUI is still drawing its boot screen): the
    // generation returns to the probe polling loop, and the next iteration
    // re-runs the full detect → guard → carrier → paste sequence.  The
    // retry cadence is the probe interval, bounded by the row lifecycle
    // (expiry, overwrite, consumption) — never a long-backoff ladder.
    logTransientResume(state, 'guard_failed')
    resumeProbePolling(state)
    return
  }
  state.resumeLogged.delete('guard_failed')
  const outcome = await sendAfterGuard(state, pid)
  if (!outcome.sent) {
    // A backgrounded codex is equally transient: the row is still current
    // and the holder unchanged, so the generation returns to the polling
    // loop.  A cancelled or superseded generation resumes nothing and
    // falls through to retire only itself.
    if (outcome.reason === 'carrier_backgrounded') {
      logTransientResume(state, 'carrier_backgrounded')
      if (resumeProbePolling(state)) return
    } else {
      state.resumeLogged.delete('carrier_backgrounded')
      rlog(deps,
        `codex-recovery cancelled: pane=${row.pane_id} ` +
        `reason=${outcome.reason}` +
        holderRefusalLogSuffix(outcome.reason)
      )
    }
  }
  // Delivered or terminally failed, the send retires this generation
  // (only transient refusals resume); retire the generation's pane
  // registration so the map cannot grow with finished generations.
  cancelOwnGeneration(state)
}

// Transient refusals repeat every probe interval while the pane stays in the
// same state, so each CONSECUTIVE streak of one reason logs exactly once; the
// marker clears when that stage passes again (guard pass, or a non-carrier
// send outcome), so a later relapse logs anew.
function logTransientResume(state: ProbeState, reason: TransientReason): void {
  if (state.resumeLogged.has(reason)) return
  state.resumeLogged.add(reason)
  rlog(state.deps,
    `codex-recovery resume: pane=${state.row.pane_id} reason=${reason} ` +
    `action=resume_probe_polling`
  )
}

/**
 * Returns a schedule to the polling loop after a transient refusal (failed
 * quiet guard or backgrounded carrier).  Re-registers the SAME generation —
 * no new token, so overwrite/consumption cancellation still targets exactly
 * it and the pane keeps a single live schedule entry — and arms the next
 * probe tick.  Returns false when the generation was cancelled or superseded
 * meanwhile; nothing is re-registered then.
 */
function resumeProbePolling(state: ProbeState): boolean {
  const { entry, row, deps } = state
  if (!generationActive(state)) return false
  recoverySchedules.set(row.pane_id, entry)
  entry.timer = setTimeout(
    () => { void probeIteration(state) },
    deps.probeIntervalMs ?? RECOVERY_PROBE_INTERVAL_MS
  )
  return true
}

interface SendOutcome {
  sent: boolean
  reason?: string
}

/**
 * Post-guard send path run by every probe-loop attempt: re-probe the codex
 * process, re-check row currency and holder identity, then pane-host-verify
 * and paste with the guard already consumed (skipGuard).
 * The poke content is built from the freshly resolved holder, never from the
 * identity captured at schedule time.
 */
async function sendAfterGuard(
  state: ProbeState,
  expectedPid: number
): Promise<SendOutcome> {
  const { row, deps } = state
  if (!generationActive(state)) return { sent: false, reason: 'cancelled' }
  const detected = await detectCodexProcess(state)
  if (!generationActive(state)) return { sent: false, reason: 'cancelled' }
  if (detected === undefined) return { sent: false, reason: 'codex_process_gone' }
  if (detected.pid !== expectedPid) {
    return { sent: false, reason: 'codex_pid_changed' }
  }
  if (!rowStillCurrent(state)) return { sent: false, reason: 'row_stale' }
  const resolution = resolveCurrentHolder(state)
  if ('skip' in resolution) return { sent: false, reason: resolution.skip }
  const holder = resolution.holder

  const verify = deps.verifyPaneHost ?? makeDefaultVerify(deps)
  const stillCurrent = (): boolean => rowStillCurrent(state)
  // Composite synchronous confirm for every write checkpoint inside the tmux
  // primitive (pre-capture, pre-paste, and pre-Enter): generation not
  // cancelled, row snapshot current (sync sqlite), holder tuple unchanged and
  // still dead (sync sqlite), and the target-side carrier proof — the codex
  // pid is still the pane tty's foreground carrier.  Holder-style pid
  // liveness is NOT enough here: a SIGSTOP-ed codex keeps kill(pid, 0) true
  // while the shell is foreground, and the paste would execute in the shell.
  // Any probe failure (error, timeout, EPERM) reads as unsafe: no write.
  const probeSync = deps.foregroundProbeSync ?? defaultForegroundProbeSync
  // Set when the composite's ONLY failing leg was the carrier proof seeing a
  // live-but-backgrounded codex: a transient refusal that must not retire
  // the generation.  A probe hard error (catch below) deliberately does not
  // set it — unknown stays terminal.
  let carrierBackgrounded = false
  const confirmOwnership = (): boolean => {
    try {
      if (
        !generationActive(state)
        || !rowStillCurrent(state)
        || 'skip' in resolveCurrentHolder(state)
      ) {
        return false
      }
      const carrier = classifyCodexCarrier({
        lines: probeSync(detected.tty),
        pid: detected.pid,
        uuid: row.xats_agent_id,
      })
      if (carrier === 'backgrounded') carrierBackgrounded = true
      return carrier === 'foreground'
    } catch {
      return false
    }
  }
  const verdict = await verify({
    paneId: row.pane_id,
    pid: detected.pid,
    holderAgentId: holder.agent_id,
    stillCurrent,
  })
  if (!generationActive(state)) return { sent: false, reason: 'cancelled' }
  if (!verdict.ok) return { sent: false, reason: verdict.reason }

  const tmuxPoke = deps.tmuxPoke ?? tmuxPokeImpl
  // Minted per send, not per schedule: a retry of the same generation reissues
  // and invalidates the previous token, so only the notice actually sitting in
  // the pane can be quoted back.
  const nonce = mintCodexRecoveryNonce(row.pane_id)
  const result = await tmuxPoke({
    pane_id: row.pane_id,
    content: buildCodexRecoveryPokeContent({ ...holder, nonce }),
    skipGuard: true,
    confirmOwnership,
  })
  // Any outcome that left the notice in the pane counts as delivered, not just
  // the successful one: the seeding trigger reads this to leave such a pane
  // alone rather than mint a second token that would silently invalidate the
  // notice already sitting there.  Keyed on THIS nonce so a send that outlived
  // its generation cannot flag a replacement nothing has written yet.
  if (pokeWroteContent(result)) markCodexRecoveryNonceDelivered(nonce)
  if ('ok' in result && result.ok) {
    rlog(deps,
      `codex-recovery delivered: pane=${row.pane_id} ` +
      `identity=(${holder.team}, ${holder.name})`
    )
    return { sent: true }
  }
  const error = (result as { error: string }).error
  // Nothing was written and the only failing leg was foreground-ness: a
  // distinct reason lets the send path resume polling.  ownership_lost
  // (pasted-but-unexecuted) stays terminal even when the carrier refused.
  if (error === 'pane_reassigned' && carrierBackgrounded) {
    return { sent: false, reason: 'carrier_backgrounded' }
  }
  return { sent: false, reason: error }
}

function makeDefaultVerify(
  deps: CodexRecoveryDeps
): NonNullable<CodexRecoveryDeps['verifyPaneHost']> {
  return async args =>
    verifyPaneHost({
      row: {
        agent_id: args.holderAgentId,
        device: deps.localDevice,
        runtime_ui_pid: args.pid,
      },
      paneId: args.paneId,
      paneSnapshot: await loadTmuxPaneSnapshot(),
      localDevice: deps.localDevice,
      // Ownership here is the pre-reg row still being current, not an agents
      // pane binding: the holder row has not re-bound the pane yet.
      stillOwnsPane: () => args.stillCurrent(),
    })
}
