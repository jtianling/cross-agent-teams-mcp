import type { ThreadRuntimeRow } from '../storage/agents-repo.js'

/** The physical seat a same-thread registration inherits EXACTLY: no
 *  detection may substitute another pid, tty, or pane for these fields. */
export interface InheritSeat {
  agent_id: string
  runtime_ui_pid: number | null
  runtime_tty: string | null
  tmux_pane_id: string | null
}

/** Every outcome carries the evidence row/seat counts so the register flow
 *  can log ALL decisions (none / seat / ambiguous) at one decision point;
 *  ambiguous also carries the involved agent ids (never key values). */
export type SameThreadCollapse =
  | { kind: 'none'; rowCount: number; seatCount: number }
  | { kind: 'seat'; seat: InheritSeat; rowCount: number; seatCount: number }
  | {
      kind: 'ambiguous'
      rowCount: number
      seatCount: number
      agentIds: string[]
    }

function hasPositivePid(row: ThreadRuntimeRow): boolean {
  return row.runtime_ui_pid !== null && row.runtime_ui_pid > 0
}

/** Two evidence rows sit on one physical seat when they share a positive
 *  pid or a tty.  A rename chain A→B→C leaves every abandoned row with its
 *  pid/tty intact (only the pane is LWW-cleared), so seat identity must be
 *  computed on the surviving fields, never on row count. */
function sharesSeat(a: ThreadRuntimeRow, b: ThreadRuntimeRow): boolean {
  if (hasPositivePid(a) && a.runtime_ui_pid === b.runtime_ui_pid) return true
  return a.runtime_tty !== null && a.runtime_tty === b.runtime_tty
}

export function groupRowsBySeat(rows: ThreadRuntimeRow[]): ThreadRuntimeRow[][] {
  const groups: ThreadRuntimeRow[][] = []
  for (const row of rows) {
    const hits = groups.filter(group =>
      group.some(member => sharesSeat(member, row)))
    if (hits.length === 0) {
      groups.push([row])
      continue
    }
    // A row linking several groups (e.g. by pid to one, by tty to another)
    // proves they are one physical seat: merge them transitively.
    const [first, ...rest] = hits
    first.push(row)
    for (const other of rest) {
      first.push(...other)
      groups.splice(groups.indexOf(other), 1)
    }
  }
  return groups
}

function parseMs(value: string | null): number {
  if (value === null) return -1
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : -1
}

/** Last-writer-wins owner of one seat: latest runtime_bound_at first, a
 *  still-set pane breaks ties (only the newest bind keeps its pane), then
 *  the freshest last_seen_at. */
function lastWriterOwner(group: ThreadRuntimeRow[]): ThreadRuntimeRow {
  return [...group].sort((a, b) =>
    parseMs(b.runtime_bound_at) - parseMs(a.runtime_bound_at)
    || (b.tmux_pane_id === null ? 0 : 1) - (a.tmux_pane_id === null ? 0 : 1)
    || parseMs(b.last_seen_at) - parseMs(a.last_seen_at)
  )[0]
}

/**
 * Collapse same-thread evidence rows by PHYSICAL seat.  A unique seat folds
 * to its last-writer-wins owner and is inherited exactly; multiple DISTINCT
 * seats are ambiguous and the caller MUST fail closed (no pre-reg scan, no
 * global detection, no runtime bind).
 */
export function collapseSameThreadRows(
  rows: ThreadRuntimeRow[]
): SameThreadCollapse {
  if (rows.length === 0) return { kind: 'none', rowCount: 0, seatCount: 0 }
  const groups = groupRowsBySeat(rows)
  if (groups.length > 1) {
    return {
      kind: 'ambiguous',
      rowCount: rows.length,
      seatCount: groups.length,
      agentIds: rows.map(row => row.agent_id),
    }
  }
  const owner = lastWriterOwner(groups[0])
  return {
    kind: 'seat',
    rowCount: rows.length,
    seatCount: 1,
    seat: {
      agent_id: owner.agent_id,
      runtime_ui_pid: owner.runtime_ui_pid,
      runtime_tty: owner.runtime_tty,
      tmux_pane_id: owner.tmux_pane_id,
    },
  }
}
