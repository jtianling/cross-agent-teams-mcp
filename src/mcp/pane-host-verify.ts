import { isAlive } from '../daemon/pid.js'
import { readPidTty } from '../daemon/pid-tty.js'
import { listTmuxPaneRows, type TmuxPaneRow } from '../daemon/tmux-pane-list.js'

export interface PaneHostRow {
  agent_id: string
  device: string
  runtime_ui_pid: number | null
}

/** `null` means tmux could not be queried, so rules 3 and 4 are undecidable. */
export type PaneSnapshot = Map<string, TmuxPaneRow> | null

export type PaneSnapshotLoader = () => Promise<PaneSnapshot>

export type PaneHostVerdict =
  | { ok: true }
  | { ok: false; reason: 'pane_reassigned' }
  | { ok: false; reason: 'undecidable' }

export interface FindPaneClaimantsFn {
  (args: { device: string; paneId: string; excludeAgentId: string }): PaneHostRow[]
}

export interface VerifyPaneHostArgs {
  row: PaneHostRow
  paneId: string
  paneSnapshot: PaneSnapshot
  localDevice: string
  isProcessAlive?: (pid: number) => boolean
  readPidTty?: (pid: number) => Promise<string | null>
  findPaneClaimants?: FindPaneClaimantsFn
  /** Current DB truth for `(agent_id, pane)`, checked against a stale cached row. */
  stillOwnsPane?: (agentId: string, paneId: string) => boolean
}

const VERIFIED: PaneHostVerdict = { ok: true }
const REASSIGNED: PaneHostVerdict = { ok: false, reason: 'pane_reassigned' }
/** tmux could not be queried, so ownership is unknown — never inject on unknown. */
const UNDECIDABLE: PaneHostVerdict = { ok: false, reason: 'undecidable' }

export async function loadTmuxPaneSnapshot(): Promise<PaneSnapshot> {
  try {
    const panes = await listTmuxPaneRows()
    return new Map(panes.map(pane => [pane.pane_id, pane]))
  } catch {
    return null
  }
}

/** One tmux query per fan-out round, shared by every recipient in that round. */
export function memoizePaneSnapshot(
  load: PaneSnapshotLoader = loadTmuxPaneSnapshot
): PaneSnapshotLoader {
  let pending: Promise<PaneSnapshot> | undefined
  return () => (pending ??= load())
}

function hasPid(row: PaneHostRow): boolean {
  return row.runtime_ui_pid !== null && row.runtime_ui_pid > 0
}

/**
 * Four-level predicate, first match wins: remote device → dead pid → live pid
 * whose tty/pane_pid matches the pane → pid-less row losing to a confirmed
 * live host on the same pane.
 */
export async function verifyPaneHost(args: VerifyPaneHostArgs): Promise<PaneHostVerdict> {
  const { row, paneId, paneSnapshot, localDevice } = args
  if (row.device !== localDevice) return REASSIGNED

  // The target row was read before this point, so last-writer-wins may already
  // have moved the pane to somebody else. Trust the DB over the cached row.
  if (args.stillOwnsPane !== undefined && !args.stillOwnsPane(row.agent_id, paneId)) {
    return REASSIGNED
  }

  if (hasPid(row)) return verifyPidHost(args, row.runtime_ui_pid as number)

  if (paneSnapshot === null) return UNDECIDABLE
  if (!paneSnapshot.has(paneId)) return REASSIGNED

  const claimants = args.findPaneClaimants?.({
    device: row.device,
    paneId,
    excludeAgentId: row.agent_id,
  }) ?? []
  for (const claimant of claimants.filter(hasPid)) {
    const verdict = await verifyPidHost(args, claimant.runtime_ui_pid as number, claimant)
    if (verdict.ok) return REASSIGNED
  }
  return VERIFIED
}

async function verifyPidHost(
  args: VerifyPaneHostArgs,
  pid: number,
  row: PaneHostRow = args.row
): Promise<PaneHostVerdict> {
  if (row.device !== args.localDevice) return REASSIGNED
  const alive = args.isProcessAlive ?? isAlive
  if (!alive(pid)) return REASSIGNED

  if (args.paneSnapshot === null) return UNDECIDABLE
  const pane = args.paneSnapshot.get(args.paneId)
  if (!pane) return REASSIGNED
  if (pane.pane_pid !== null && pane.pane_pid === pid) return VERIFIED

  const tty = await (args.readPidTty ?? readPidTty)(pid)
  return tty !== null && tty === pane.tty ? VERIFIED : REASSIGNED
}
