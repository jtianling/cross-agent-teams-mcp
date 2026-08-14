import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { parseDeliveryRow, type DeliverySpec } from '../lib/delivery-spec.js'
import {
  isTmuxAvailable,
  capturePaneTail,
  loadBuffer,
  pasteBuffer,
  sendEnter,
  deleteBuffer
} from '../daemon/tmux-cli.js'
import {
  defaultForegroundProbeSync,
  defaultPaneTtySync,
  isForegroundCodexCarrier,
} from './auto-bind-codex-pane.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import {
  dispatchPoke,
  resolveAgentType,
  type TargetRow as DispatchTargetRow,
  type TmuxPokeResult,
} from './transport-dispatch.js'
import { runQuietGuard } from './poke-guard.js'
import {
  memoizePaneSnapshot,
  verifyPaneHost,
  type PaneHostRow,
  type PaneHostVerdict,
  type PaneSnapshotLoader,
} from './pane-host-verify.js'

// allowCrossTeam is for internal auto-poke callers only; MCP tool entry MUST NOT pass it.
export interface PokeDeps {
  db: Database.Database
  callerAgentId: string | null
  allowCrossTeam?: boolean
  channelWakeFanout?: ChannelWakeFanout
  localDevice?: string
  // Supplied by fan-out so one tmux snapshot serves the whole round.
  paneSnapshot?: PaneSnapshotLoader
  /** Sync seams for the codex foreground-carrier confirm at the tmux write
   *  checkpoints.  Tests MUST inject both: the defaults shell out to real
   *  tmux/ps. */
  paneTtySync?: (paneId: string) => string | undefined
  foregroundProbeSync?: (tty: string) => string[]
}

export interface PokeInput {
  target_agent_id: string
  prompt: string
  skipGuard?: boolean
}

export type PokeResult =
  | {
      ok: true
      transport_used: 'claude-channel'
      channel_session_id: string
    }
  | {
      ok: true
      transport_used: 'tmux-poke'
      pane_id: string
      pane_tail_before: string
      pane_tail_after: string
    }
  | {
      ok: true
      transport_used: 'codex-appserver'
      thread_id: string
    }
  | {
      ok: true
      transport_used: 'opencode-server'
      session_id: string
    }
  | {
      ok: true
      transport_used: 'kimi-server'
      session_id: string
    }
  | {
      error: string
      detail?: unknown
      transport_used?: 'tmux-poke' | 'codex-appserver' | 'opencode-server' | 'kimi-server'
    }

interface TargetRow {
  agent_id: string
  agent_type: import('../lib/agent-type.js').AgentType | null
  device: string
  team: string
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  opencode_runtime_generation: number
  delivery_kind: string
  delivery_payload: string | null
}

export const PROMPT_MAX_BYTES = 8192
export const PASTE_SETTLE_MS = 400
export const TAIL_LINES = 8

type TmuxStage = 'capture_before' | 'load_buffer' | 'paste_buffer' | 'send_keys' | 'capture_after'

interface StageError {
  stage: TmuxStage
  cause: unknown
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorMessage(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const err = cause as { stderr?: string | Buffer; message?: string }
    if (err.stderr) {
      const s = typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8')
      if (s.length > 0) return s
    }
    if (err.message) return err.message
  }
  return String(cause)
}

export function classifyTmuxError(err: StageError): { error: string; detail: unknown } {
  const msg = errorMessage(err.cause)
  const lower = msg.toLowerCase()
  if (lower.includes("can't find pane") || lower.includes('pane not found') || lower.includes('no such pane')) {
    return { error: 'pane_dead', detail: msg }
  }
  return { error: 'tmux_cmd_failed', detail: { stage: err.stage, stderr: msg } }
}

async function runStage<T>(stage: TmuxStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    throw { stage, cause } as StageError
  }
}

// paste-buffer -d is the only deletion on the success path; an abort after a
// successful load must not leave the message body parked in a named buffer.
// Returns false when the delete itself failed so the caller can surface the
// leaked buffer without masking the abort being reported.
async function discardBuffer(bufName: string): Promise<boolean> {
  try {
    await deleteBuffer(bufName)
    return true
  } catch {
    return false
  }
}

// The primary abort keeps its error; the failed cleanup rides along as a
// detail naming the buffer that may still hold the message body.  The body
// itself is never included.
function noteCleanupFailure(
  result: { error: string; detail?: unknown },
  bufName: string
): { error: string; detail?: unknown } {
  const detail: Record<string, unknown> = { buffer_cleanup_failed: bufName }
  if (result.detail !== undefined) detail.cause = result.detail
  return { ...result, detail }
}

// Exported for the codex recovery poke, which pastes into a pre-registered
// pane through the same guard + ownership-recheck primitive.
export async function tmuxPokeImpl(args: {
  pane_id: string
  content: string
  skipGuard?: boolean
  confirmOwnership?: () => boolean
}): Promise<TmuxPokeResult> {
  if (!(await isTmuxAvailable())) {
    return { error: 'tmux_unavailable', detail: 'tmux binary not available on PATH' }
  }
  const bufName = `poke-${randomBytes(3).toString('hex')}`
  // True from a successful load-buffer until paste-buffer -d consumes it;
  // any abort in that window must best-effort delete the named buffer.
  let bufferPending = false
  try {
    if (!args.skipGuard) {
      // Guard inside the try so a pane that dies mid-window is classified
      // (pane_dead / tmux_cmd_failed) instead of throwing out of the primitive.
      const guard = await runStage('capture_before', () => runQuietGuard(args.pane_id))
      if (guard === 'fail') return { error: 'guard_failed' }
    }
    // Last ownership read before anything is written. The guard above parks for
    // POKE_QUIET_MS, which is long enough for a takeover to land, so the
    // dispatcher's earlier check cannot be the one the write relies on. This is
    // synchronous and immediately precedes the write, leaving no await in between.
    if (args.confirmOwnership && !args.confirmOwnership()) {
      return { error: 'pane_reassigned' }
    }
    const pane_tail_before = await runStage('capture_before', () => capturePaneTail(args.pane_id, TAIL_LINES))
    await runStage('load_buffer', () => loadBuffer(bufName, args.content))
    bufferPending = true
    // Final ownership read: capture/load above awaited, so the earlier check no
    // longer immediately precedes the write. This one is synchronous with no
    // await between it and the paste.
    if (args.confirmOwnership && !args.confirmOwnership()) {
      if (!(await discardBuffer(bufName))) {
        return noteCleanupFailure({ error: 'pane_reassigned' }, bufName)
      }
      return { error: 'pane_reassigned' }
    }
    await runStage('paste_buffer', () => pasteBuffer(bufName, args.pane_id))
    bufferPending = false
    await delay(PASTE_SETTLE_MS)
    // Ownership can move during the paste settle window. Pasted-but-unexecuted
    // text is recoverable; an executed Enter is not — so one more synchronous
    // read aborts here rather than sending the keypress. Distinct error so
    // callers can tell "nothing written" (pane_reassigned) from "pasted but
    // never executed" (ownership_lost).
    if (args.confirmOwnership && !args.confirmOwnership()) {
      return { error: 'ownership_lost' }
    }
    await runStage('send_keys', () => sendEnter(args.pane_id))
    await delay(PASTE_SETTLE_MS)
    const pane_tail_after = await runStage('capture_after', () => capturePaneTail(args.pane_id, TAIL_LINES))
    return { ok: true, pane_tail_before, pane_tail_after }
  } catch (e) {
    const classified = classifyTmuxError(e as StageError)
    if (bufferPending && !(await discardBuffer(bufName))) {
      return noteCleanupFailure(classified, bufName)
    }
    return classified
  }
}

/**
 * Whether a poke left its content sitting in the pane.
 *
 * Lives here rather than at the call sites because only this module knows
 * which stages run AFTER `paste_buffer`.  A caller that re-derived the answer
 * from the error name alone would silently go stale the next time a stage is
 * added or reordered, and the callers that need it are the ones deciding
 * whether a one-time token is still quotable — the wrong answer there either
 * strands a pane forever or invalidates a token that really is in the pane.
 *
 * `ok` and `ownership_lost` (pasted, Enter never sent) are the documented
 * positives.  `tmux_cmd_failed` is positive only for the post-paste stages:
 * the throw came after the content was already in the pane.  `pane_dead` is
 * NOT positive even post-paste — the pane that held the content is gone.
 */
export function pokeWroteContent(result: TmuxPokeResult): boolean {
  if ('ok' in result && result.ok) return true
  const failure = result as { error: string; detail?: unknown }
  if (failure.error === 'ownership_lost') return true
  if (failure.error !== 'tmux_cmd_failed') return false
  const stage = (failure.detail as { stage?: unknown } | undefined)?.stage
  return stage === 'send_keys' || stage === 'capture_after'
}

export async function poke(deps: PokeDeps, input: PokeInput): Promise<PokeResult> {
  if (!deps.callerAgentId) return { error: 'unknown_agent' }

  const promptLen = Buffer.byteLength(input.prompt, 'utf8')
  if (promptLen > PROMPT_MAX_BYTES) {
    return { error: 'prompt_too_long', detail: { max: PROMPT_MAX_BYTES, got: promptLen } }
  }

  const target = deps.db
    .prepare(
      `SELECT
         agent_id,
         agent_type,
         device,
         team,
         tmux_pane_id,
         runtime_ui_pid,
         opencode_runtime_generation,
         delivery_kind,
         delivery_payload
       FROM agents
       WHERE agent_id = ?`
    )
    .get(input.target_agent_id) as TargetRow | undefined
  if (!target) return { error: 'unknown_target' }

  if (target.agent_id === deps.callerAgentId) return { error: 'self_poke_denied' }

  const callerRow = deps.db
    .prepare(`SELECT team FROM agents WHERE agent_id = ?`)
    .get(deps.callerAgentId) as { team: string } | undefined
  if (!callerRow) return { error: 'unknown_agent' }
  if (callerRow.team !== target.team && !deps.allowCrossTeam) {
    return { error: 'cross_team_denied' }
  }

  // Legacy callers may not have ChannelWakeFanout. Keep the historical tmux-only
  // fallback for plain targets, but still allow non-tmux transports that are
  // fully described by the target row itself.
  const fanout = deps.channelWakeFanout
  const delivery = parseDeliveryRow(target) as DeliverySpec
  const dispatchTarget: DispatchTargetRow = {
    agent_id: target.agent_id,
    agent_type: target.agent_type,
    device: target.device,
    delivery,
    tmux_pane_id: target.tmux_pane_id,
    runtime_ui_pid: target.runtime_ui_pid,
    opencode_runtime_generation: target.opencode_runtime_generation,
  }
  const verify = createPaneHostVerifier(deps)
  const confirmOwn = ({ row, paneId }: { row: DispatchTargetRow; paneId: string }): boolean =>
    row.device !== (deps.localDevice ?? 'local')
    || (stillOwnsPane(deps.db, row.agent_id, paneId)
      && confirmCodexForegroundCarrier(deps, row, paneId))
  if (!fanout) {
    if (delivery.kind === 'codex-appserver' || delivery.kind === 'opencode-server' || delivery.kind === 'kimi-server') {
      return dispatchPoke(
        { tmuxPoke: tmuxPokeImpl, verifyPaneHost: verify, confirmPaneOwnership: confirmOwn },
        dispatchTarget,
        { content: input.prompt, meta: {}, skipGuard: input.skipGuard }
      )
    }

    // Legacy tmux-only path preserved when no fanout supplied by caller. It
    // routes through the same dispatcher so verification, the undecidable →
    // tmux_unavailable mapping and the pre-write ownership recheck cannot drift.
    if (!target.tmux_pane_id) return { error: 'tmux_pane_not_set' }
    return dispatchPoke(
      { tmuxPoke: tmuxPokeImpl, verifyPaneHost: verify, confirmPaneOwnership: confirmOwn },
      dispatchTarget,
      { content: input.prompt, meta: {}, skipGuard: input.skipGuard }
    )
  }

  return dispatchPoke(
    { channelWakeFanout: fanout, tmuxPoke: tmuxPokeImpl, verifyPaneHost: verify, confirmPaneOwnership: confirmOwn },
    dispatchTarget,
    { content: input.prompt, meta: {}, skipGuard: input.skipGuard }
  )
}

function findPaneClaimants(
  db: Database.Database,
  args: { device: string; paneId: string; excludeAgentId: string | null }
): PaneHostRow[] {
  return db
    .prepare(
      `SELECT agent_id, device, runtime_ui_pid
       FROM agents
       WHERE device = ? AND tmux_pane_id = ? AND agent_id != ?`
    )
    .all(args.device, args.paneId, args.excludeAgentId ?? '') as PaneHostRow[]
}

/**
 * TARGET-side carrier proof for codex tmux fallbacks, run at every write
 * checkpoint of the shared tmux primitive: the DB ownership read above cannot
 * see a SIGSTOP-ed or backgrounded codex whose shell owns the tty again
 * (kill(pid, 0) stays true), so a codex target with a bound runtime_ui_pid
 * must also prove that pid is the pane tty's foreground codex --remote
 * process.  The stored uuid is unavailable on this path; the command-level
 * match suffices.  Fail-closed: a missing tty or any probe error reads as
 * unsafe.  The gate keys off the EFFECTIVE agent type (the dispatcher's
 * resolveAgentType), so a legacy row with agent_type=NULL and a
 * codex-appserver delivery cannot bypass the proof on its tmux fallback.
 * The same latent hazard exists for claude/other TUI targets;
 * deliberately NOT widened to them in this change (tracked as a follow-up).
 */
function confirmCodexForegroundCarrier(
  deps: PokeDeps,
  row: DispatchTargetRow,
  paneId: string
): boolean {
  if (resolveAgentType(row) !== 'codex') return true
  const pid = row.runtime_ui_pid
  if (pid === null || pid <= 0) return true
  try {
    const tty = (deps.paneTtySync ?? defaultPaneTtySync)(paneId)
    if (!tty) return false
    const probe = deps.foregroundProbeSync ?? defaultForegroundProbeSync
    return isForegroundCodexCarrier({ lines: probe(tty), pid })
  } catch {
    return false
  }
}

function stillOwnsPane(
  db: Database.Database,
  agentId: string | null,
  paneId: string
): boolean {
  if (agentId === null) return false
  const row = db
    .prepare(`SELECT 1 AS held FROM agents WHERE agent_id = ? AND tmux_pane_id = ?`)
    .get(agentId, paneId) as { held: number } | undefined
  return row !== undefined
}

function createPaneHostVerifier(
  deps: PokeDeps
): (args: { row: DispatchTargetRow; paneId: string }) => Promise<PaneHostVerdict> {
  const loadSnapshot = deps.paneSnapshot ?? memoizePaneSnapshot()
  return async ({ row, paneId }) =>
    verifyPaneHost({
      row,
      paneId,
      paneSnapshot: await loadSnapshot(),
      localDevice: deps.localDevice ?? 'local',
      findPaneClaimants: args => findPaneClaimants(deps.db, args),
      stillOwnsPane: (agentId, pane) => stillOwnsPane(deps.db, agentId, pane),
    })
}
