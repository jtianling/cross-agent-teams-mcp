import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { CodexPanePreRegRepo, CodexPanePreRegRow } from './codex-pane-pre-register-repo.js'
import type {
  BindRuntimeIdentityService,
  VerifiedRuntimeIdentity,
} from './bind-runtime-identity.js'
import { planIdentityKeyBinding } from './register-agent.js'
import { isAlive } from '../daemon/pid.js'
import type { IdentityKeyMatch } from '../storage/agents-repo.js'
import { describeRedactedError } from './log-redact.js'

const TMUX_LIST_TIMEOUT_MS = 3_000
const PS_LIST_TIMEOUT_MS = 3_000

export interface PaneTtyEntry {
  pane_id: string
  tty: string
}

export interface AutoBindCodexPaneDeps {
  listPanes?: () => Promise<PaneTtyEntry[]>
  ttyProcesses?: (tty: string) => Promise<string[]>
  now?: () => Date
}

export interface IdentityKeyAttachDeps {
  findCaller: (agentId: string) => {
    team: string
    name: string
    identity_key: string | null
  } | undefined
  findByIdentityKey: (key: string) => IdentityKeyMatch[]
  applyPlan: (
    plan: { kind: 'bind' } | { kind: 'migrate'; from_agent_id: string },
    callerAgentId: string,
    key: string
  ) => void
  isProcessAlive?: (pid: number) => boolean
  log?: (line: string) => void
}

export interface AutoBindCodexPaneInput {
  callerAgentId: string
  repo: CodexPanePreRegRepo
  bindRuntimeIdentitySvc: BindRuntimeIdentityService
  /** Runs the claim re-check, the runtime write (with its incumbent-pane
   *  eviction), the conditional consume and the key attach as ONE synchronous
   *  transaction — its rollback is the complete undo.  REQUIRED: without a
   *  real transaction a refused claim or a failing attach would leave a
   *  persisted bind or a consumed row behind, so there is deliberately no
   *  "run it unwrapped" mode. */
  runAtomic: <T>(fn: () => T) => T
  /** Generation minted by the registration this scan serves; the pane bind's
   *  final write is conditional on it (stale registration binds fail closed). */
  expectedRegisterGeneration: number
  identityKeyAttach?: IdentityKeyAttachDeps
  onConsumed?: (pane_id: string) => void
  log?: (line: string) => void
}

function normalizeTty(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const normalized = value.replace(/^\/dev\//, '')
  if (!normalized || normalized === '?') return undefined
  return normalized
}

export async function defaultListPanes(): Promise<PaneTtyEntry[]> {
  const exec = promisify(execFile)
  const { stdout } = await exec(
    'tmux',
    ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}'],
    { timeout: TMUX_LIST_TIMEOUT_MS }
  )
  return stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const [pane_id, pane_tty] = line.split('\t')
      return {
        pane_id,
        tty: normalizeTty(pane_tty) ?? '',
      }
    })
}

export async function defaultTtyProcesses(tty: string): Promise<string[]> {
  const exec = promisify(execFile)
  const { stdout } = await exec(
    'ps',
    ['-t', tty, '-o', 'pid=,pgid=,tpgid=,stat=,command='],
    { timeout: PS_LIST_TIMEOUT_MS }
  )
  return stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
}

export interface CarrierPsEntry {
  pid: number
  pgid: number
  tpgid: number
  stat: string
  command: string
}

/** Parses one `ps -o pid=,pgid=,tpgid=,stat=,command=` line; malformed
 *  columns yield undefined so every caller fails closed. */
export function parseCarrierPsLine(line: string): CarrierPsEntry | undefined {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/)
  if (!m) return undefined
  return {
    pid: Number(m[1]),
    pgid: Number(m[2]),
    tpgid: Number(m[3]),
    stat: m[4],
    command: m[5],
  }
}

/**
 * A STAT containing T/t/Z is a stopped (SIGSTOP/traced) or zombie process:
 * the shell owns the tty again, so such a line must never count as a live
 * codex carrier.  A missing stat reads the same way, fail-closed.
 */
export function isStoppedOrZombieStat(stat: string | undefined): boolean {
  return stat === undefined || /[TtZ]/.test(stat)
}

export function isCodexRemoteProcess(line: string): boolean {
  if (!/codex/i.test(line)) return false
  if (/codex\s+app-server/i.test(line)) return false
  return /codex(?:-aarch64-a)?\s+.*--remote/i.test(line) || /codex(?:-aarch64-a)?\s+--remote/i.test(line)
}

export function argvContainsUuid(line: string, uuid: string): boolean {
  return line.includes(`xats.agent_id="${uuid}"`)
}

/**
 * Full foreground-carrier proof on one parsed ps entry: STAT free of T/t/Z,
 * command still codex --remote (with the stored uuid when given — the generic
 * poke path has no stored uuid and relies on the command-level match), and
 * the process group owning the tty foreground (pgid === tpgid).  Pid liveness
 * (kill(pid, 0)) can never substitute: a SIGSTOP-ed or backgrounded codex
 * keeps its pid alive while the shell is foreground again, and a paste would
 * then execute in the shell.
 */
export function isForegroundCodexEntry(
  entry: CarrierPsEntry,
  uuid?: string
): boolean {
  return !isStoppedOrZombieStat(entry.stat)
    && isCodexRemoteProcess(entry.command)
    && (uuid === undefined || argvContainsUuid(entry.command, uuid))
    && entry.tpgid > 0
    && entry.pgid === entry.tpgid
}

/**
 * TARGET-side carrier proof over a foreground-probe snapshot, positive
 * evidence only: a missing line, malformed columns, or an unknown foreground
 * group all read as NOT safe.
 */
export function isForegroundCodexCarrier(args: {
  lines: string[]
  pid: number
  uuid?: string
}): boolean {
  for (const line of args.lines) {
    const entry = parseCarrierPsLine(line)
    if (entry === undefined || entry.pid !== args.pid) continue
    return isForegroundCodexEntry(entry, args.uuid)
  }
  return false
}

export type CodexCarrierState = 'foreground' | 'backgrounded' | 'absent'

/**
 * Classifies the pid's carrier state on a foreground-probe snapshot.
 * 'backgrounded' is the single transient refusal: a live codex --remote
 * (command and optional uuid match, STAT free of T/t/Z) whose process group
 * is not the tty's foreground group — it can return to the foreground
 * later.  Everything else that fails the foreground proof — missing line,
 * malformed columns, stopped/zombie STAT, command mismatch — reads as
 * 'absent' (fail-closed, terminal for callers).
 */
export function classifyCodexCarrier(args: {
  lines: string[]
  pid: number
  uuid?: string
}): CodexCarrierState {
  for (const line of args.lines) {
    const entry = parseCarrierPsLine(line)
    if (entry === undefined || entry.pid !== args.pid) continue
    if (isForegroundCodexEntry(entry, args.uuid)) return 'foreground'
    const liveCodex = !isStoppedOrZombieStat(entry.stat)
      && isCodexRemoteProcess(entry.command)
      && (args.uuid === undefined || argvContainsUuid(entry.command, args.uuid))
    return liveCodex ? 'backgrounded' : 'absent'
  }
  return 'absent'
}

export interface CarrierMatchCollapse {
  /** The single logical carrier entry, or undefined when the matches do not
   *  collapse (no match, cross-pgid ambiguity, or a leaderless group). */
  entry: CarrierPsEntry | undefined
  matchCount: number
  distinctPgids: number
  skipReason?: 'no_match' | 'multi_pgid' | 'no_foreground_leader'
}

/**
 * Collapses matching ps lines on one tty into a single logical codex
 * carrier.  aoe launches codex through a node wrapper, so a legitimate pane
 * shows TWO matching lines: the wrapper (process-group leader, pid === pgid)
 * and the native child sharing the pgid.  When every match belongs to one
 * process group AND that group owns the tty foreground (pgid === tpgid on
 * every line), the pair is ONE candidate whose pid is the group leader's.
 * A same-group set with no leader line fails closed, and matches spanning
 * different pgids stay genuinely ambiguous.
 */
export function collapseCarrierMatches(
  matches: CarrierPsEntry[]
): CarrierMatchCollapse {
  const distinctPgids = new Set(matches.map(m => m.pgid)).size
  const base = { matchCount: matches.length, distinctPgids }
  if (matches.length === 0) {
    return { ...base, entry: undefined, skipReason: 'no_match' }
  }
  if (matches.length === 1) return { ...base, entry: matches[0] }
  if (distinctPgids !== 1) {
    return { ...base, entry: undefined, skipReason: 'multi_pgid' }
  }
  const foreground = matches.every(m => m.tpgid > 0 && m.pgid === m.tpgid)
  const leader = matches.find(m => m.pid === m.pgid)
  if (!foreground || leader === undefined) {
    return { ...base, entry: undefined, skipReason: 'no_foreground_leader' }
  }
  return { ...base, entry: leader }
}

export const FOREGROUND_PROBE_TIMEOUT_MS = 2_000

/** Synchronous ps against a pane tty for write-time carrier proofs.
 *  Tests MUST inject a replacement: this shells out to real `ps`. */
export function defaultForegroundProbeSync(tty: string): string[] {
  const stdout = execFileSync(
    'ps',
    ['-t', tty, '-o', 'pid=,pgid=,tpgid=,stat=,command='],
    { timeout: FOREGROUND_PROBE_TIMEOUT_MS, encoding: 'utf8' }
  )
  return stdout.split('\n').map(line => line.trimEnd()).filter(Boolean)
}

/** Synchronous pane-tty lookup for write-time confirms that only hold the
 *  pane id.  Tests MUST inject a replacement: this shells out to real tmux. */
export function defaultPaneTtySync(paneId: string): string | undefined {
  const stdout = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', paneId, '#{pane_tty}'],
    { timeout: TMUX_LIST_TIMEOUT_MS, encoding: 'utf8' }
  )
  return normalizeTty(stdout.trim())
}

/**
 * Foreground-carrier probe for the detect_tmux_pane fallback bind: returns
 * the unique foreground `codex --remote` carrier pid on the pane tty (the
 * group leader after wrapper+child collapse), or undefined when no unique
 * foreground carrier exists.  No stored uuid is available on this path, so
 * the match is command-level only; any probe failure reads as no carrier.
 */
export async function detectForegroundCodexCarrierPid(
  tty: string,
  deps: AutoBindCodexPaneDeps = {}
): Promise<number | undefined> {
  const ttyProcesses =
    deps.ttyProcesses ?? __testOverrides.ttyProcesses ?? defaultTtyProcesses
  try {
    const procs = await ttyProcesses(tty)
    const matching = procs
      .map(parseCarrierPsLine)
      .filter((entry): entry is CarrierPsEntry =>
        entry !== undefined && isForegroundCodexEntry(entry))
    return collapseCarrierMatches(matching).entry?.pid
  } catch {
    return undefined
  }
}

interface Candidate {
  row: CodexPanePreRegRow
  pane_id: string
  ui_pid: number
}

/**
 * Scan pending pre-regs, look up tmux panes and their processes, and bind
 * the caller agent row when exactly one pre-reg maps to a codex --remote
 * process whose argv contains the stored UUID and that passes the full
 * foreground-carrier proof on its pane tty (isForegroundCodexEntry).
 * Multiple matching lines that share one foreground process group (wrapper
 * plus native child) collapse into a single candidate via
 * collapseCarrierMatches; cross-pgid matches remain ambiguous and skip.
 *
 * Outcome: 'bound_consumed' when the pane bind persisted AND the matched
 * pre-reg row was consumed (key attach ran); 'bound_stale' when the pane
 * bind persisted but an overwrite raced it — the new row, its key, and its
 * recovery schedule are all untouched, so callers MUST NOT run any
 * row-derived follow-up (e.g. seat-follow) on this outcome; false when
 * nothing persisted.  Any error path returns false without propagating.
 */
// Test hook: allows integration tests to override the tmux/ps probes that
// would otherwise need a real tmux session.  Production paths pass `deps`
// explicitly; when they do not, we fall through to these overrides, then to
// the real child_process-backed defaults.
export const __testOverrides: AutoBindCodexPaneDeps = {}

export type AutoBindCodexPaneResult = 'bound_consumed' | 'bound_stale' | false

export async function autoBindCodexPane(
  input: AutoBindCodexPaneInput,
  deps: AutoBindCodexPaneDeps = {}
): Promise<AutoBindCodexPaneResult> {
  try {
    const now = deps.now ?? __testOverrides.now ?? (() => new Date())
    const nowIso = now().toISOString()
    input.repo.deleteExpired(nowIso)
    const pending = input.repo.listUnexpired(nowIso)
    if (pending.length === 0) return false

    const candidates = await collectCandidates(input, deps, pending)
    if (candidates.length !== 1) {
      // The ONLY correlation this scan has is "exactly one machine-wide
      // candidate", so anything else must fail closed.  Say so: every OTHER
      // refusal here logs its reason, and staying silent on the one that
      // fires whenever two codex panes have overlapping pre-reg windows made
      // it indistinguishable from "the scan never ran" — the fallback's
      // pane_has_pending_prereg line was the only trace, which points at the
      // pane rather than at the count that actually decided it.
      input.log?.(
        `auto-bind skip (debug): reason=candidate_count caller=` +
        `${input.callerAgentId} candidates=${candidates.length} ` +
        `pending=${pending.length} ` +
        `panes=${candidates.map(c => c.pane_id).join(',') || '-'}`
      )
      return false
    }

    const chosen = candidates[0]
    // The candidate snapshot predates the awaits above; a launcher overwrite
    // in between means this bind would serve the wrong generation.
    if (!sameSnapshot(chosen.row, input.repo.getByPaneId(chosen.pane_id))) {
      return false
    }
    // Split verify (async probes, writes nothing) from commit (synchronous):
    // everything that must agree — the re-arbitrated claim, the runtime write
    // WITH its incumbent-pane eviction, the conditional consume and the key
    // attach — then lives in ONE transaction whose rollback is a complete
    // undo.  A post-hoc "clear the caller row" cannot undo the LWW eviction
    // the write performed on another agent's pane binding, so composing the
    // write into the transaction is the only correct shape.
    const verified = await input.bindRuntimeIdentitySvc.verify({
      callerAgentId: input.callerAgentId,
      agent: 'codex',
      ui_pid: chosen.ui_pid,
      expectedRegisterGeneration: input.expectedRegisterGeneration,
    })
    if ('error' in verified) return false

    return commitClaimedPane(input, chosen, verified)
  } catch {
    return false
  }
}

/**
 * Probes every pending row's pane for the full foreground-carrier proof and
 * drops rows whose identity key says they belong to someone else.
 */
async function collectCandidates(
  input: AutoBindCodexPaneInput,
  deps: AutoBindCodexPaneDeps,
  pending: CodexPanePreRegRow[]
): Promise<Candidate[]> {
  const listPanes = deps.listPanes ?? __testOverrides.listPanes ?? defaultListPanes
  const ttyProcesses =
    deps.ttyProcesses ?? __testOverrides.ttyProcesses ?? defaultTtyProcesses

  let panes: PaneTtyEntry[]
  try {
    panes = await listPanes()
  } catch {
    return []
  }
  const paneIndex = new Map<string, PaneTtyEntry>()
  for (const pane of panes) {
    if (pane.pane_id) paneIndex.set(pane.pane_id, pane)
  }

  const ttyProcessCache = new Map<string, string[]>()
  const candidates: Candidate[] = []
  const caller = makeCallerReader(input)

  for (const row of pending) {
    const pane = paneIndex.get(row.pane_id)
    if (!pane || !pane.tty) {
      // The daemon shells out to BARE tmux, so it only sees the server its own
      // environment resolves to: a row whose pane lives on another server (or
      // is simply gone) drops out here.  That silently subtracts from the
      // candidate count, which is the scan's ONLY correlation — leaving it
      // unlogged meant a row could vanish from consideration with no trace at
      // all, and reading the log afterwards could not tell that apart from the
      // row never having existed.
      input.log?.(
        `auto-bind skip (debug): pane=${row.pane_id} ` +
        `reason=${pane ? 'pane_tty_unknown' : 'pane_not_visible'} ` +
        `caller=${input.callerAgentId}`
      )
      continue
    }
    let procs = ttyProcessCache.get(pane.tty)
    if (procs === undefined) {
      try {
        procs = await ttyProcesses(pane.tty)
      } catch {
        procs = []
      }
      ttyProcessCache.set(pane.tty, procs)
    }
    const candidate = evaluateRow(input, row, pane.pane_id, procs, caller)
    if (candidate !== undefined) candidates.push(candidate)
  }
  return candidates
}

/**
 * The caller row, read at most ONCE and only when some pending row actually
 * carries a key — the keyless path stays independent of the attach deps.
 */
function makeCallerReader(
  input: AutoBindCodexPaneInput
): () => CallerIdentity | undefined {
  let read: { value: CallerIdentity | undefined } | undefined
  return () => {
    if (read === undefined) {
      read = { value: input.identityKeyAttach?.findCaller(input.callerAgentId) }
    }
    return read.value
  }
}

/**
 * One pending row against one pane's process listing: the foreground-carrier
 * proof, then the identity-key claim.  Every rejection logs its own reason.
 */
function evaluateRow(
  input: AutoBindCodexPaneInput,
  row: CodexPanePreRegRow,
  paneId: string,
  procs: string[],
  caller: () => CallerIdentity | undefined
): Candidate | undefined {
  const collapsed = collapseForegroundCarrier(procs, row.xats_agent_id)
  if (collapsed.entry === undefined) {
    input.log?.(
      `auto-bind skip (debug): pane=${paneId} ` +
      `reason=${collapsed.skipReason} matches=${collapsed.matchCount} ` +
      `distinct_pgids=${collapsed.distinctPgids}`
    )
    return undefined
  }
  // The scan's only other correlation is "unique machine-wide candidate whose
  // pane tty hosts a codex carrying the stored uuid", which proves the PANE's
  // codex identity and never the CALLER's.  A row whose key says it is someone
  // else's must be disqualified entirely, not merely denied the key attach:
  // binding and consuming a foreign row strands its owner unbound and keyless
  // and points the caller's seat at another pane.
  const claim = row.identity_key === null
    ? { foreign: false as const }
    : classifyRowClaim({ row, caller: caller(), deps: input.identityKeyAttach })
  if (claim.foreign) {
    input.log?.(
      `auto-bind skip (debug): pane=${paneId} ` +
      `reason=${claim.reason} caller=${input.callerAgentId}`
    )
    return undefined
  }
  return { row, pane_id: paneId, ui_pid: collapsed.entry.pid }
}

/**
 * Candidate acceptance demands the FULL foreground-carrier proof, not just a
 * live-looking line: a backgrounded codex (STAT S, shell owns the tty
 * foreground) must neither bind nor consume the pre-reg row.  A wrapper+child
 * pair sharing the foreground process group collapses into one candidate whose
 * ui_pid is the group leader.
 */
function collapseForegroundCarrier(
  procs: string[],
  uuid: string
): CarrierMatchCollapse {
  const matching = procs
    .map(parseCarrierPsLine)
    .filter((entry): entry is CarrierPsEntry =>
      entry !== undefined && isForegroundCodexEntry(entry, uuid)
    )
  return collapseCarrierMatches(matching)
}

/**
 * The synchronous commit.  Everything here shares one transaction, so any
 * refusal or thrown error rolls the whole thing back — no runtime write, no
 * incumbent eviction, no consumed row, no attached key.  That is what makes
 * "the row turned out to be someone else's" recoverable at all: the bind is
 * not undone afterwards, it never lands.
 */
function commitClaimedPane(
  input: AutoBindCodexPaneInput,
  chosen: Candidate,
  verified: VerifiedRuntimeIdentity
): AutoBindCodexPaneResult {
  const consumedKey: { value: string | null } = { value: null }
  try {
    const outcome = input.runAtomic(() =>
      runClaimCommit(input, chosen, verified, consumedKey)
    )
    if (outcome === 'bound_consumed') {
      // Post-commit, best-effort: cancelling a recovery schedule is in-memory
      // state that must not be able to roll the committed transaction back.
      try {
        input.onConsumed?.(chosen.pane_id)
      } catch (error) {
        input.log?.(
          `auto-bind hook error: pane=${chosen.pane_id} stage=onConsumed ` +
          `error=${describeRedactedError(error, consumedKey.value)}`
        )
      }
    }
    return outcome
  } catch (error) {
    // Transaction rolled back: nothing was written, so there is no residual
    // binding to compensate for and the caller may fail closed as usual.
    input.log?.(
      `auto-bind commit rolled back: pane=${chosen.pane_id} ` +
      `error=${describeRedactedError(error, consumedKey.value)}`
    )
    return false
  }
}

/**
 * The transaction body.  Everything here shares one commit precondition, so
 * any refusal or thrown error rolls the whole thing back — no runtime write,
 * no incumbent-pane eviction, no consumed row, no attached key.  That is what
 * makes "the row turned out to be someone else's" recoverable at all: the
 * bind is not undone afterwards, it never lands.
 */
function runClaimCommit(
  input: AutoBindCodexPaneInput,
  chosen: Candidate,
  verified: VerifiedRuntimeIdentity,
  consumedKey: { value: string | null }
): AutoBindCodexPaneResult {
  if (!reArbitrateClaim(input, chosen)) return false
  const written = input.bindRuntimeIdentitySvc.commit(
    input.callerAgentId,
    verified
  )
  if ('error' in written) return false

  // Conditional consume on the full original snapshot: an overwrite that
  // landed during the verification keeps its new row, its new key and its new
  // recovery schedule.
  const consumed = input.repo.takeMatching(chosen.row)
  if (consumed === undefined) {
    input.log?.(
      `auto-bind stale runtime bind: pane=${chosen.pane_id} ` +
      `reason=pre-reg row overwritten during bind; row not consumed, ` +
      `no key attached`
    )
    return 'bound_stale'
  }
  consumedKey.value = consumed.identity_key
  applyConsumedKeyOrThrow(input, chosen, consumed.identity_key)
  return 'bound_consumed'
}

/**
 * The claim was decided before the verification await, so the rightful owner
 * may have taken the key in between.  Deciding again inside the transaction is
 * what makes the earlier decision safe to act on.
 */
function reArbitrateClaim(
  input: AutoBindCodexPaneInput,
  chosen: Candidate
): boolean {
  if (chosen.row.identity_key === null) return true
  const claim = classifyRowClaim({
    row: chosen.row,
    caller: input.identityKeyAttach?.findCaller(input.callerAgentId),
    deps: input.identityKeyAttach,
  })
  if (!claim.foreign) return true
  input.log?.(
    `auto-bind skip (debug): pane=${chosen.pane_id} ` +
    `reason=${claim.reason} caller=${input.callerAgentId} stage=post_verify`
  )
  return false
}

/**
 * Attach in the SAME transaction as the consume, and THROW on refusal.
 * Returning instead would commit the worst state this whole change exists to
 * prevent: incumbent evicted, recovery row consumed, key attached nowhere —
 * and the row, being the only carrier of that key, is then gone for good.
 * Liveness can flip between the re-arbitration and the planner's own check, so
 * this is reachable without any bug elsewhere.
 */
function applyConsumedKeyOrThrow(
  input: AutoBindCodexPaneInput,
  chosen: Candidate,
  key: string | null
): void {
  if (!key || !input.identityKeyAttach) return
  const attached = attachConsumedIdentityKey({
    callerAgentId: input.callerAgentId,
    key,
    ui_pid: chosen.ui_pid,
    deps: input.identityKeyAttach,
  })
  if ('refused' in attached) {
    throw new Error(`identity_key attach refused: ${attached.refused}`)
  }
}


function sameSnapshot(
  a: CodexPanePreRegRow,
  b: CodexPanePreRegRow | undefined
): boolean {
  return b !== undefined
    && a.pane_id === b.pane_id
    && a.xats_agent_id === b.xats_agent_id
    && a.identity_key === b.identity_key
    && a.expires_at === b.expires_at
}

type CallerIdentity = {
  team: string
  name: string
  identity_key: string | null
}

/**
 * Decide whether a keyed pre-reg row can belong to this caller.
 *
 * This is deliberately NOT `planIdentityKeyBinding`: that rule arbitrates the
 * key AFTER the caller has proven it owns the pane, so it excludes conflicts
 * against the caller's OWN ui_pid.  During the scan there is no caller pid to
 * exclude with — the only pid available is the CANDIDATE PANE's carrier, and
 * feeding it in makes the arbitration self-exclude exactly when the foreign
 * holder IS that pane's foreground codex (holder pid === candidate pid), i.e.
 * it opens the hole in the one shape that matters most.  Candidacy therefore
 * takes positive proof only: another identity's key is foreign unless that
 * identity is provably gone (positive pid that is NOT running).  A keyless
 * row contradicts nothing; missing attach deps (legacy/in-process callers)
 * keep the pre-change behaviour.
 */
function classifyRowClaim(args: {
  row: { identity_key: string | null }
  caller: CallerIdentity | undefined
  deps: IdentityKeyAttachDeps | undefined
}): { foreign: false } | { foreign: true; reason: string } {
  const key = args.row.identity_key
  if (key === null || args.deps === undefined || args.caller === undefined) {
    return { foreign: false }
  }
  if (args.caller.identity_key !== null && args.caller.identity_key !== key) {
    return { foreign: true, reason: 'identity_key_contradiction' }
  }
  const holder = args.deps.findByIdentityKey(key)[0]
  if (holder === undefined) return { foreign: false }
  if (holder.team === args.caller.team && holder.name === args.caller.name) {
    return { foreign: false }
  }
  const pid = holder.runtime_ui_pid
  if (pid === null || pid <= 0) {
    // No pid recorded is liveness UNKNOWN, never "dead" — a tty/pane bind
    // legitimately records none.  Same lesson as seat-follow's liveness rule.
    return { foreign: true, reason: 'identity_key_holder_liveness_unknown' }
  }
  const alive = args.deps.isProcessAlive ?? isAlive
  if (alive(pid)) {
    return { foreign: true, reason: 'identity_key_live_holder_conflict' }
  }
  return { foreign: false }
}

/**
 * Refusals are RETURNED, never swallowed: the caller turns them into a thrown
 * error so the surrounding transaction rolls back.  The reason text names no
 * key value — it lands in a log line.
 */
function attachConsumedIdentityKey(args: {
  callerAgentId: string
  key: string
  ui_pid: number
  deps: IdentityKeyAttachDeps
}): { ok: true } | { refused: string } {
  const { deps } = args
  const caller = deps.findCaller(args.callerAgentId)
  if (!caller) {
    return { refused: `reason=caller_row_missing caller=${args.callerAgentId}` }
  }
  if (caller.identity_key !== null && caller.identity_key !== args.key) {
    return {
      refused: `reason=caller_holds_different_key caller=${args.callerAgentId}`,
    }
  }
  const plan = planIdentityKeyBinding({
    holder: deps.findByIdentityKey(args.key)[0],
    target: { team: caller.team, name: caller.name },
    ui_pid: args.ui_pid,
    isProcessAlive: deps.isProcessAlive,
  })
  if ('error' in plan) {
    return {
      refused: `reason=identity_key_live_holder_conflict ` +
        `holder=(${plan.detail.team}, ${plan.detail.name})`,
    }
  }
  deps.applyPlan(plan, args.callerAgentId, args.key)
  return { ok: true }
}
