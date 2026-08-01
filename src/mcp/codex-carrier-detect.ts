import {
  argvContainsUuid,
  collapseCarrierMatches,
  defaultListPanes,
  defaultTtyProcesses,
  isCodexRemoteProcess,
  isStoppedOrZombieStat,
  parseCarrierPsLine,
  type CarrierMatchCollapse,
  type CarrierPsEntry,
  type PaneTtyEntry,
} from './auto-bind-codex-pane.js'

export interface DetectedCodexCarrier {
  pid: number
  tty: string
}

export interface CodexCarrierDetectRequest {
  paneId: string
  /** The pre-reg row's uuid, which the launcher also put on the codex command
   *  line: the proof that the pane's codex is the launch the row describes. */
  uuid: string
  listPanes?: () => Promise<PaneTtyEntry[]>
  ttyProcesses?: (tty: string) => Promise<string[]>
  /** One probe stage failed (broken tmux/ps).  Reported rather than logged
   *  here: every scheduler logs it once per generation, so a broken host is
   *  visible without a line per probe interval. */
  onStageError?: (stage: 'list_panes' | 'tty_processes', error: unknown) => void
  /** Matching lines that did NOT collapse into one foreground process group.
   *  Fires only for genuine ambiguity, never for the ordinary "codex not up
   *  yet" — that one is silent by design. */
  onAmbiguous?: (collapsed: CarrierMatchCollapse) => void
}

/**
 * The pane's codex carrier, or undefined while there is none to act on.
 *
 * A stopped (SIGSTOP/traced) or zombie codex is not a detection: the shell
 * owns the tty again, so treating it as up would aim a paste at the shell.
 * Foreground-ness is deliberately NOT required here for a single match; the
 * write-time carrier proof enforces it before anything is written.  A
 * wrapper+child pair sharing the foreground process group collapses into one
 * detection whose pid is the group leader's; matches spanning different pgids
 * stay ambiguous and detect nothing.
 */
export async function detectCodexCarrier(
  req: CodexCarrierDetectRequest
): Promise<DetectedCodexCarrier | undefined> {
  const listPanes = req.listPanes ?? defaultListPanes
  const ttyProcesses = req.ttyProcesses ?? defaultTtyProcesses
  let panes: PaneTtyEntry[]
  try {
    panes = await listPanes()
  } catch (error) {
    req.onStageError?.('list_panes', error)
    return undefined
  }
  const pane = panes.find(p => p.pane_id === req.paneId)
  if (!pane || !pane.tty) return undefined
  let procs: string[]
  try {
    procs = await ttyProcesses(pane.tty)
  } catch (error) {
    req.onStageError?.('tty_processes', error)
    return undefined
  }
  const matching = procs
    .map(parseCarrierPsLine)
    .filter((entry): entry is CarrierPsEntry =>
      entry !== undefined
      && isCodexRemoteProcess(entry.command)
      && argvContainsUuid(entry.command, req.uuid)
      && !isStoppedOrZombieStat(entry.stat)
    )
  const collapsed = collapseCarrierMatches(matching)
  if (collapsed.entry === undefined) {
    if (collapsed.matchCount > 1) req.onAmbiguous?.(collapsed)
    return undefined
  }
  return { pid: collapsed.entry.pid, tty: pane.tty }
}
