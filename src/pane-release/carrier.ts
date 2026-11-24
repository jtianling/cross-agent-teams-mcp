import { tryCanonicalOpencodeBaseUrl } from '../lib/opencode-url.js'
import { PaneProbeError, type PaneProbes, type PaneSnapshot,
  type ProcessSnapshot, type SocketSnapshot } from '../pane-lookup/probes.js'
import type { TmuxCoordinates } from '../pane-lookup/schema.js'
import { identical } from './snapshot.js'

export class ReleaseConflict extends Error {
  constructor(readonly code: string, readonly detail: string) { super(detail) }
}

export interface PaneScope {
  socket: SocketSnapshot
  pane: PaneSnapshot
}

async function scopedInventory(tmux: TmuxCoordinates,
  probes: PaneProbes,
) {
  const socket = await probes.socket(tmux.socket_path)
  const panes = await probes.panes(socket)
  if (panes.some(pane => pane.socket_path !== socket.path
    || pane.server_pid !== tmux.server_pid
    || pane.server_started_at !== tmux.server_started_at)) {
    throw new ReleaseConflict('pane_unverifiable', 'tmux_server_changed')
  }
  const matches = panes.filter(pane => pane.pane_id === tmux.pane_id)
  if (matches.length !== 1) {
    throw new ReleaseConflict('pane_unverifiable', 'pane_missing_or_ambiguous')
  }
  return { socket, pane: matches[0], panes }
}

export async function inspectScope(tmux: TmuxCoordinates,
  probes: PaneProbes,
): Promise<PaneScope> {
  const { socket, pane, panes } = await scopedInventory(tmux, probes)
  if (pane.dead === true || pane.pane_pid <= 0 || !pane.tty) {
    throw new ReleaseConflict('pane_unverifiable', 'pane_not_running')
  }
  if (panes.filter(item => item.dead !== true
    && item.pane_pid > 0 && item.tty === pane.tty)
    .length !== 1) {
    throw new ReleaseConflict('pane_unverifiable', 'pane_tty_ambiguous')
  }
  return { socket, pane }
}

export async function inspectDeadScope(tmux: TmuxCoordinates,
  probes: PaneProbes,
): Promise<PaneScope> {
  const { socket, pane } = await scopedInventory(tmux, probes)
  if (pane.dead !== true || pane.pane_pid !== 0 || pane.tty !== '') {
    throw new ReleaseConflict('pane_unverifiable', 'dead_pane_evidence_required')
  }
  return { socket, pane }
}

export function parseOpencodeAttach(command: string) {
  const match = command.match(
    /^(?:(?:\S*\/)?node\s+)?(?:\S*\/)?opencode(?:-[\w-]+)?\s+attach\s+([^\s'"\\]+)\s+(?:-s|--session)(?:\s+|=)(ses[^\s'"\\]+)(.*)$/,
  )
  if (!match || /(?:^|\s)(?:-s\S*|--session(?:\s|=|$))/.test(match[3])) return undefined
  const baseUrl = tryCanonicalOpencodeBaseUrl(match[1])
  return baseUrl === undefined ? undefined
    : { base_url: baseUrl, session_id: match[2] }
}

export function isForeground(process: ProcessSnapshot, pane: PaneSnapshot) {
  return process.tty === pane.tty && !/[TtZ]/.test(process.stat)
    && process.pgid === process.tpgid && process.tpgid > 0
    && process.started_at >= pane.server_started_at * 1000
}

export function carrierKinds(processes: ProcessSnapshot[]): string[] {
  const names = [
    ['claude-code', /^(?:\S*\/)?claude(?:\s|$)/],
    ['codex', /^(?:\S*\/)?codex(?:-[\w-]+)?(?:\s|$)/],
    ['opencode', /^(?:(?:\S*\/)?node\s+)?(?:\S*\/)?opencode(?:-[\w-]+)?(?:\s|$)/],
  ] as const
  return names.filter(([, pattern]) => processes.some(process =>
    pattern.test(process.command))).map(([kind]) => kind)
}

export async function foregroundProcesses(pane: PaneSnapshot, probes: PaneProbes) {
  if (!probes.ttyProcesses) throw new PaneProbeError('foreground_probe_unavailable')
  const root = await probes.process(pane.pane_pid)
  if (!root || /[TtZ]/.test(root.stat) || root.tty !== pane.tty
    || root.started_at < pane.server_started_at * 1000) {
    throw new ReleaseConflict('pane_unverifiable', 'pane_process_changed')
  }
  const processes = (await probes.ttyProcesses(pane.tty))
    .filter(process => isForeground(process, pane)
      && process.started_at >= root.started_at)
  const current = await probes.process(pane.pane_pid)
  if (!identical(root, current)) {
    throw new ReleaseConflict('stale_binding', 'pane_process_changed')
  }
  return { root, processes }
}

export function selectOpencode(processes: ProcessSnapshot[]) {
  const matches = processes.flatMap(process => {
    const runtime = parseOpencodeAttach(process.command)
    return runtime ? [{ process, runtime }] : []
  })
  if (matches.length === 0) return undefined
  if (new Set(matches.map(({ process }) => process.pgid)).size !== 1
    || new Set(matches.map(({ runtime }) => JSON.stringify(runtime))).size !== 1) {
    throw new ReleaseConflict('ambiguous_identity', 'opencode_carrier_ambiguous')
  }
  const leader = matches.find(({ process }) => process.pid === process.pgid)
  if (!leader) {
    throw new ReleaseConflict('pane_unverifiable', 'opencode_foreground_leader_missing')
  }
  return leader
}
