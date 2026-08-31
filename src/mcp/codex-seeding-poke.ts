import type {
  CodexPanePreRegRepo,
  CodexPanePreRegRow,
} from './codex-pane-pre-register-repo.js'
import type { AcceptedPreRegRow } from './pre-register-codex-pane.js'
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
import { hasLiveCodexRecoverySchedule } from './codex-recovery-poke.js'
import {
  clearCodexRecoveryNoncesForPane,
  hasDeliveredCodexRecoveryNonce,
  markCodexRecoveryNonceDelivered,
  mintCodexRecoveryNonce,
} from './codex-recovery-nonce.js'
import { pokeWroteContent, tmuxPokeImpl } from './poke.js'
import {
  isCodexComposerReady,
  PROMPT_NOT_READY,
} from './codex-prompt-readiness.js'
import type { TmuxPokeResult } from './transport-dispatch.js'
import { describeRedactedError } from './log-redact.js'

/**
 * The SEEDING round: a codex pane that has no prior xats identity at all.
 *
 * The recovery round can address its notice to an identity because the row's
 * identity_key names an agent row.  The seeding round has none — that is what
 * makes it the seeding round — and an agent row acquires a key only by
 * consuming a pre-registration row, which is exactly the step that two
 * overlapping pre-registration windows block.  Nothing seeds, so nothing ever
 * becomes recoverable.
 *
 * Deliberately a PARALLEL path rather than a "holder is optional" mode of the
 * recovery one: every recovery guard is expressed against a non-optional
 * holder, and a nullable branch in a guard is where a guard stops guarding.
 * The primitives are shared (carrier detection, carrier classification, the
 * nonce store, the tmux write primitive); the holder-shaped delivery machinery
 * is not.
 */

export const SEEDING_PROBE_INTERVAL_MS = 5_000

/** Two panes announced at once is the condition under which the scan's
 *  unique-candidate rule refuses every caller.  Below it the existing rule
 *  already selects correctly and a paste would buy nothing. */
const AMBIGUITY_THRESHOLD = 2

export interface CodexSeedingDeps {
  repo: CodexPanePreRegRepo
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
    confirmOwnership?: () => boolean
    requireReady?: (paneTail: string) => boolean
  }) => Promise<TmuxPokeResult>
  log?: (line: string) => void
}

interface SeedingScheduleEntry {
  timer?: ReturnType<typeof setTimeout>
  cancelled: boolean
  /** Generation token; unique per schedule, never reused. */
  messageId: string
}

// Module-level for the same reason recovery's maps are: registerBusinessTools
// runs once per MCP session, so per-instance state could not see a
// cancellation arriving on another session (overwrite or consumption).
const seedingSchedules = new Map<string, SeedingScheduleEntry>()
// Generation authority per pane: the schedule entry leaves seedingSchedules
// when the send begins, but the in-flight send lives on.
const currentGenerationMessageId = new Map<string, string>()
let seedingGeneration = 0

function nowIso(deps: CodexSeedingDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString()
}

function slog(deps: CodexSeedingDeps, line: string): void {
  deps.log?.(`[${nowIso(deps)}] ${line}`)
}

/**
 * Seeding notice wording.  It asserts NO team, NO name and NO identity key:
 * the pane has no prior identity to be told about, and the key must never
 * appear in model context under the same rule that governs the recovery
 * notice.  All it asks for is the token on the register_agent call — the
 * token fixes WHICH row that registration consumes, never WHO registers.
 */
export function buildCodexSeedingPokeContent(args: { nonce: string }): string {
  return [
    '[cross-agent-teams pane token]',
    'Two or more codex panes are pre-registering at the same time, so',
    'cross-agent-teams (xats) cannot tell from its own side which pane is',
    'which. When you call the cross-agent-teams MCP tool register_agent, add',
    `recovery_nonce: "${args.nonce}" to that call (copy the value exactly).`,
    'This daemon wrote the token into THIS pane only, so quoting it back is',
    'what tells the daemon which pane you are. It supplies nothing else about',
    'the registration.',
  ].join(' ')
}

/** Generation token: unique per schedule generation, never reused. */
export function seedingRetryMessageId(
  paneId: string,
  generation: number
): string {
  return `codex-seeding:${paneId}:${generation}`
}

export interface SeedingCancelOptions {
  reason?: string
  log?: (line: string) => void
  now?: () => Date
}

export function cancelCodexSeedingSchedule(
  paneId: string,
  opts: SeedingCancelOptions = {}
): void {
  const entry = seedingSchedules.get(paneId)
  const hadGeneration = currentGenerationMessageId.has(paneId)
  if (entry) {
    entry.cancelled = true
    if (entry.timer) clearTimeout(entry.timer)
    seedingSchedules.delete(paneId)
  }
  // A send that already left the schedule map may still be in flight; retiring
  // the generation token makes it abort at its next cancellation checkpoint.
  currentGenerationMessageId.delete(paneId)
  // The token belongs to the schedule: once the row is consumed, replaced or
  // expired, a surviving nonce would still point at this pane.  Cleared even
  // when no schedule is left — a DELIVERED notice retires its generation while
  // its token stays outstanding, and that token is exactly what must go.  The
  // store is shared with recovery, which is safe because every call site
  // cancels both paths for the pane together.
  clearCodexRecoveryNoncesForPane(paneId)
  if ((entry !== undefined || hadGeneration) && opts.reason && opts.log) {
    const iso = (opts.now ?? (() => new Date()))().toISOString()
    opts.log(
      `[${iso}] codex-seeding cancelled: pane=${paneId} reason=${opts.reason}`
    )
  }
}

export function clearAllCodexSeedingSchedules(
  opts: SeedingCancelOptions = {}
): void {
  const panes = new Set([
    ...seedingSchedules.keys(),
    ...currentGenerationMessageId.keys(),
  ])
  for (const paneId of panes) cancelCodexSeedingSchedule(paneId, opts)
}

export function __peekCodexSeedingSchedules(): string[] {
  return Array.from(seedingSchedules.keys())
}

/**
 * Called after every accepted pre_register_codex_pane, AFTER the recovery
 * evaluation so a pane it just scheduled already holds its token here.
 *
 * The trigger is two or more unexpired pending rows, evaluated on the write
 * because that is the moment the second row becomes observable.  When it
 * fires, EVERY pending pane without a live token is scheduled, not only the
 * pane that just wrote: the earlier pane's codex may already be up and about
 * to register.
 */
export function evaluateCodexSeedingOnPreRegister(
  row: AcceptedPreRegRow,
  deps: CodexSeedingDeps
): void {
  cancelCodexSeedingSchedule(row.pane_id, {
    reason: 'row_replaced',
    log: deps.log,
    now: deps.now,
  })
  const pending = deps.repo.listUnexpired(nowIso(deps))
  if (pending.length < AMBIGUITY_THRESHOLD) {
    // Logged even though nothing happens: a silent no-op is indistinguishable
    // from a broken trigger, which is how the gap this closes survived
    // unnoticed in the first place.
    slog(deps,
      `codex-seeding trigger: writer=${row.pane_id} pending=${pending.length} ` +
      `outcome=no_ambiguity`
    )
    return
  }
  const seeded: string[] = []
  const held: string[] = []
  for (const pendingRow of pending) {
    // One live token per pane, in the three shapes a pane can already hold
    // one: a recovery schedule that has not sent yet, a token already sitting
    // in the pane (recovery's or an earlier seeding round's), and a seeding
    // generation of this round's own.
    const holder = paneTokenHolder(pendingRow.pane_id)
    if (holder !== undefined) {
      held.push(`${pendingRow.pane_id}(${holder})`)
      continue
    }
    scheduleSeeding(pendingRow, deps)
    seeded.push(pendingRow.pane_id)
  }
  slog(deps,
    `codex-seeding trigger: writer=${row.pane_id} pending=${pending.length} ` +
    `outcome=scheduled seeded=${seeded.join(',') || '-'} ` +
    `held=${held.join(',') || '-'}`
  )
}

/** Why the pane already holds a token, or undefined when it holds none. */
function paneTokenHolder(
  paneId: string
): 'recovery' | 'token' | 'seeding' | undefined {
  if (hasLiveCodexRecoverySchedule(paneId)) return 'recovery'
  if (hasDeliveredCodexRecoveryNonce(paneId)) return 'token'
  if (currentGenerationMessageId.has(paneId)) return 'seeding'
  return undefined
}

interface SeedState {
  entry: SeedingScheduleEntry
  /** Row snapshot this generation serves; every checkpoint re-reads the stored
   *  row and requires full equality with it. */
  row: CodexPanePreRegRow
  deps: CodexSeedingDeps
  /** Lines that would otherwise repeat every probe interval (probe-stage
   *  errors, transient refusals): logged once per generation per key. */
  loggedOnce: Set<string>
}

function scheduleSeeding(
  row: CodexPanePreRegRow,
  deps: CodexSeedingDeps
): void {
  seedingGeneration += 1
  const messageId = seedingRetryMessageId(row.pane_id, seedingGeneration)
  const entry: SeedingScheduleEntry = { cancelled: false, messageId }
  seedingSchedules.set(row.pane_id, entry)
  currentGenerationMessageId.set(row.pane_id, messageId)
  const state: SeedState = { entry, row, deps, loggedOnce: new Set() }
  // First probe fires immediately: the codex may already be up by the time
  // the pre-register call lands.
  entry.timer = setTimeout(() => { void probeIteration(state) }, 0)
}

function generationActive(state: SeedState): boolean {
  return !state.entry.cancelled
    && currentGenerationMessageId.get(state.row.pane_id)
      === state.entry.messageId
}

/** Generation-scoped cancel used from inside a probe/send closure: it may only
 *  retire itself, never a newer generation that replaced it. */
function cancelOwnGeneration(state: SeedState): void {
  const { entry, row } = state
  entry.cancelled = true
  if (entry.timer) clearTimeout(entry.timer)
  if (seedingSchedules.get(row.pane_id) === entry) {
    seedingSchedules.delete(row.pane_id)
  }
  if (currentGenerationMessageId.get(row.pane_id) === entry.messageId) {
    currentGenerationMessageId.delete(row.pane_id)
  }
}

function rowStillCurrent(state: SeedState): boolean {
  const current = state.deps.repo.getByPaneId(state.row.pane_id)
  // Full-snapshot equality: a same-value overwrite with a refreshed expiry is
  // a new generation and must not keep this schedule's sends alive.
  return current !== undefined
    && current.xats_agent_id === state.row.xats_agent_id
    && current.identity_key === state.row.identity_key
    && current.expires_at === state.row.expires_at
    && current.expires_at > nowIso(state.deps)
}

function rowGoneReason(state: SeedState): string {
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

function logOnce(state: SeedState, key: string, line: string): void {
  if (state.loggedOnce.has(key)) return
  state.loggedOnce.add(key)
  slog(state.deps, line)
}

async function probeIteration(state: SeedState): Promise<void> {
  const { entry, row, deps } = state
  if (!generationActive(state)) return
  try {
    // The row leaving the pending state (expired, consumed, or overwritten)
    // terminates polling before any probe or send.
    if (!rowStillCurrent(state)) {
      slog(deps,
        `codex-seeding cancelled: pane=${row.pane_id} ` +
        `reason=${rowGoneReason(state)}`
      )
      cancelOwnGeneration(state)
      return
    }
    const detected = await detectCodexProcess(state)
    if (!generationActive(state)) return
    if (detected === undefined) {
      entry.timer = setTimeout(
        () => { void probeIteration(state) },
        deps.probeIntervalMs ?? SEEDING_PROBE_INTERVAL_MS
      )
      return
    }
    logOnce(state, `detected:${detected.pid}`,
      `codex-seeding detected: pane=${row.pane_id} pid=${detected.pid}`
    )
    if (seedingSchedules.get(row.pane_id) === entry) {
      seedingSchedules.delete(row.pane_id)
    }
    await sendSeedingPoke(state, detected)
  } catch (error) {
    slog(deps,
      `codex-seeding probe error: pane=${row.pane_id} stage=iteration ` +
      `error=${describeRedactedError(error, row.identity_key)}`
    )
    cancelOwnGeneration(state)
  }
}

async function detectCodexProcess(
  state: SeedState
): Promise<DetectedCodexCarrier | undefined> {
  const { row, deps } = state
  return detectCodexCarrier({
    paneId: row.pane_id,
    uuid: row.xats_agent_id,
    listPanes: deps.listPanes,
    ttyProcesses: deps.ttyProcesses,
    onStageError: (stage, error) => logOnce(state, `stage:${stage}`,
      `codex-seeding probe degraded (debug): pane=${row.pane_id} ` +
      `stage=${stage} ` +
      `error=${describeRedactedError(error, row.identity_key)}`
    ),
    onAmbiguous: (collapsed: CarrierMatchCollapse) =>
      logOnce(state, `detect:${collapsed.skipReason}`,
        `codex-seeding detect skip (debug): pane=${row.pane_id} ` +
        `reason=${collapsed.skipReason} matches=${collapsed.matchCount} ` +
        `distinct_pgids=${collapsed.distinctPgids}`
      ),
  })
}

/**
 * The send.  Two recovery guards are deliberately ABSENT here, and their
 * absence is the whole reason this path exists separately:
 *
 * - `resolveCurrentHolder` — there is no holder.  Its job on the recovery path
 *   is to detect drift away from the identity the notice is addressed to; a
 *   seeding notice is addressed to nobody, so there is no identity to drift.
 * - `verifyPaneHost` — it asks whether the pane has been reassigned to a
 *   DIFFERENT agent than the expected one, and there is no expected agent
 *   here.  The uuid carrier proof below answers the same question directly and
 *   more strongly: if the pane's foreground carrier is a codex running with
 *   THIS row's uuid, the pane is the one the launcher announced.
 *
 * Everything that does not presuppose a prior identity is kept: generation
 * currency, row-snapshot currency, and the composite carrier confirm
 * re-evaluated at EVERY write checkpoint inside the tmux primitive
 * (pre-capture, pre-paste, pre-Enter).  The primitive's own quiet guard runs
 * too — this is an unsolicited write into a pane a person may be typing in.
 */
async function sendSeedingPoke(
  state: SeedState,
  detected: DetectedCodexCarrier
): Promise<void> {
  const { row, deps } = state
  const probeSync = deps.foregroundProbeSync ?? defaultForegroundProbeSync
  // Set when the composite's only failing leg was the carrier proof seeing a
  // live-but-backgrounded codex: transient, so it must not retire the
  // generation.  A probe hard error stays terminal — unknown is not transient.
  let carrierBackgrounded = false
  const confirmOwnership = (): boolean => {
    try {
      if (!generationActive(state) || !rowStillCurrent(state)) return false
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
  const tmuxPoke = deps.tmuxPoke ?? tmuxPokeImpl
  // Minted per send, not per schedule: a retry reissues and invalidates the
  // previous token, so only the notice actually sitting in the pane can be
  // quoted back.
  const nonce = mintCodexRecoveryNonce(row.pane_id)
  const result = await tmuxPoke({
    pane_id: row.pane_id,
    content: buildCodexSeedingPokeContent({ nonce }),
    confirmOwnership,
    // A quiet pane is not evidence it can be typed into, and the write ends in
    // an unconditional Enter that a blocking menu would read as its answer.
    requireReady: isCodexComposerReady,
  })
  // Asked of the primitive, which is the only side that knows which stages run
  // after the paste: `ok`, a paste whose Enter never went, and a throw from a
  // post-paste stage all leave the token in the pane.  Marking is keyed on THIS
  // nonce, so a send that outlived its generation cannot flag a replacement
  // token that nothing has written yet.
  if (pokeWroteContent(result)) markCodexRecoveryNonceDelivered(nonce)
  if ('ok' in result && result.ok) {
    slog(deps, `codex-seeding delivered: pane=${row.pane_id}`)
    cancelOwnGeneration(state)
    return
  }
  const error = (result as { error: string }).error
  // A busy pane, a pane not showing a codex composer, and a backgrounded
  // carrier are all transient: the row is still pending, so the generation
  // returns to the polling loop and re-runs the full detect → confirm → paste
  // sequence.  ownership_lost (pasted-but-unexecuted) stays terminal even when
  // the carrier refused.
  const transient = error === 'guard_failed'
    || error === PROMPT_NOT_READY
    || (error === 'pane_reassigned' && carrierBackgrounded)
  if (transient) {
    logOnce(state, `resume:${error}`,
      `codex-seeding resume: pane=${row.pane_id} reason=${error} ` +
      `action=resume_probe_polling`
    )
    if (resumeProbePolling(state)) return
  } else {
    slog(deps, `codex-seeding cancelled: pane=${row.pane_id} reason=${error}`)
  }
  cancelOwnGeneration(state)
}

/**
 * Returns a schedule to the polling loop after a transient refusal.
 * Re-registers the SAME generation — no new token, so cancellation still
 * targets exactly it — and arms the next probe tick.  Returns false when the
 * generation was cancelled or superseded meanwhile.
 */
function resumeProbePolling(state: SeedState): boolean {
  const { entry, row, deps } = state
  if (!generationActive(state)) return false
  seedingSchedules.set(row.pane_id, entry)
  entry.timer = setTimeout(
    () => { void probeIteration(state) },
    deps.probeIntervalMs ?? SEEDING_PROBE_INTERVAL_MS
  )
  return true
}
