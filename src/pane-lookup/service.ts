import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { normalizeTty } from '../daemon/pid-tty.js'
import { isForegroundCodexEntry } from '../mcp/auto-bind-codex-pane.js'
import { CodexBindingRepo } from '../mcp/codex-binding-repo.js'
import {
  defaultPaneProbes, type PaneProbes, type PaneSnapshot,
  type ProcessSnapshot, type SocketSnapshot,
} from './probes.js'
import type { IdentityStatus, PaneLookupInput, RuntimeStatus } from './schema.js'

interface BindingRow {
  agent_id: string
  device: string
  name: string
  team: string
  agent_type: string | null
  runtime_ui_pid: number | null
  runtime_tty: string | null
  runtime_verification_mode: string | null
  runtime_bound_at: string | null
  register_generation: number
  delivery_kind: string
  thread_id: string | null
  channel_session_id: string | null
}
type Decision = { status: IdentityStatus; reason: string }
type Runtime = { status: RuntimeStatus; reason: string }
const UNKNOWN_RUNTIME: Runtime = { status: 'unknown', reason: 'identity_not_verified' }

function foreground(process: ProcessSnapshot): boolean {
  return !/[TtZ]/.test(process.stat) && process.tpgid > 0
    && process.pgid === process.tpgid
}

function sameProcess(a: ProcessSnapshot, b: ProcessSnapshot): boolean {
  return a.pid === b.pid && a.started_at === b.started_at && a.tty === b.tty
    && a.pgid === b.pgid && a.tpgid === b.tpgid && a.command === b.command
    && foreground(a) && foreground(b)
}

export class PaneLookupService {
  private readonly codex: CodexBindingRepo

  constructor(
    private readonly db: Database.Database,
    private readonly device: string,
    private readonly channels?: ChannelWakeFanout,
    private readonly probes: PaneProbes = defaultPaneProbes,
  ) {
    this.codex = new CodexBindingRepo(db)
  }

  private rows(pane: string): BindingRow[] {
    return this.db.prepare(
      `SELECT agent_id,device,name,team,agent_type,runtime_ui_pid,runtime_tty,
       runtime_verification_mode,runtime_bound_at,register_generation,
       delivery_kind,
       json_extract(delivery_payload,'$.thread_id') AS thread_id,
       json_extract(delivery_payload,'$.channel_session_id') AS channel_session_id
       FROM agents WHERE device = ? AND tmux_pane_id = ?
       AND role != '__channel_proxy__' ORDER BY agent_id`
    ).all(this.device, pane) as BindingRow[]
  }

  private envelope(input: PaneLookupInput, decision: Decision,
    row?: BindingRow, runtime: Runtime = UNKNOWN_RUNTIME) {
    const agent = decision.status === 'verified' && row ? {
      agent_id: row.agent_id, device: row.device, name: row.name,
      team: row.team, agent_type: row.agent_type,
    } : null
    return { ok: true as const, protocol_version: 1 as const,
      tmux: input.tmux, checked_at: new Date().toISOString(),
      identity: { ...decision, agent }, runtime }
  }

  private checkServer(input: PaneLookupInput, socket: SocketSnapshot,
    panes: PaneSnapshot[]): Decision | undefined {
    if (panes.some(p => p.socket_path !== socket.path
      || p.server_pid !== input.tmux.server_pid
      || p.server_started_at !== input.tmux.server_started_at)) {
      return { status: 'stale', reason: 'tmux_server_changed' }
    }
    const targets = panes.filter(p => p.pane_id === input.tmux.pane_id)
    if (targets.length === 0) return { status: 'stale', reason: 'pane_not_found' }
    if (targets.length > 1) return { status: 'ambiguous', reason: 'duplicate_pane_id' }
    return undefined
  }

  async lookup(input: PaneLookupInput) {
    const socket = await this.probes.socket(input.tmux.socket_path)
    const panes = await this.probes.panes(socket)
    const failure = this.checkServer(input, socket, panes)
    if (failure) return this.envelope(input, failure)
    const pane = panes.find(p => p.pane_id === input.tmux.pane_id)!
    const rows = this.rows(pane.pane_id)
    const binding = this.codex.read(pane.pane_id)
    const proofs = await Promise.all(rows.map(async row => {
      if (!row.runtime_ui_pid) return { row, process: undefined }
      return { row, process: await this.probes.process(row.runtime_ui_pid) }
    }))
    const valid = proofs.filter(({ row, process }) => process
      && this.verified(row, process, pane))
    const changed = await this.recheck(input, socket, pane)
    if (changed) return this.envelope(input, changed)
    const current = valid.length === 1
      ? await this.probes.process(valid[0].row.runtime_ui_pid!) : undefined
    if (JSON.stringify(rows) !== JSON.stringify(this.rows(pane.pane_id))
      || JSON.stringify(binding) !== JSON.stringify(this.codex.read(pane.pane_id))) {
      return this.envelope(input, { status: 'stale', reason: 'binding_changed' })
    }
    if (valid.length !== 1) {
      return this.envelope(input, this.unverified(rows, valid.length))
    }
    const { row, process } = valid[0]
    if (!current || !sameProcess(process!, current)) {
      return this.envelope(input, { status: 'stale', reason: 'carrier_changed' })
    }
    return this.envelope(input, {
      status: 'verified', reason: 'pid_tty_generation_match',
    }, row, this.readiness(row))
  }

  private unverified(rows: BindingRow[], valid: number): Decision {
    if (valid > 1) return { status: 'ambiguous', reason: 'multiple_verified_bindings' }
    if (rows.length === 0) {
      return { status: 'unbound', reason: 'no_stored_pane_binding' }
    }
    return { status: 'unverifiable', reason: 'insufficient_current_binding_evidence' }
  }

  private verified(row: BindingRow, process: ProcessSnapshot, pane: PaneSnapshot) {
    const bound = row.runtime_bound_at ? Date.parse(row.runtime_bound_at) : NaN
    if (row.runtime_verification_mode !== 'verified_pid_tty_pane'
      || normalizeTty(row.runtime_tty ?? undefined) !== pane.tty
      || process.tty !== pane.tty || !Number.isFinite(bound)
      || process.started_at + 1000 > bound
      || process.started_at < pane.server_started_at * 1000
      || !foreground(process)) return false
    if (row.agent_type === 'codex') {
      const native = /^(?:\S*\/)?codex(?:-aarch64-a)?\s+.*--remote(?:[=\s]|$)/i
        .test(process.command) && !/codex\s+app-server/i.test(process.command)
      if (!native) return false
      const binding = this.codex.read(pane.pane_id)
      if (binding) {
        return binding.agent_id === row.agent_id && binding.thread_id === row.thread_id
          && binding.runtime_ui_pid === process.pid
          && normalizeTty(binding.runtime_tty ?? undefined) === pane.tty
          && isForegroundCodexEntry(process, binding.launch_id)
      }
      return true
    }
    const executable = row.agent_type === 'claude-code' ? 'claude'
      : row.agent_type === 'opencode' ? 'opencode' : undefined
    return executable !== undefined
      && new RegExp(`^(?:\\S*/)?${executable}(?:\\s|$)`).test(process.command)
  }

  private async recheck(input: PaneLookupInput, socket: SocketSnapshot,
    pane: PaneSnapshot): Promise<Decision | undefined> {
    const next = await this.probes.socket(input.tmux.socket_path)
    if (JSON.stringify(next) !== JSON.stringify(socket)) {
      return { status: 'stale', reason: 'tmux_socket_changed' }
    }
    const panes = await this.probes.panes(next)
    const failure = this.checkServer(input, next, panes)
    if (failure) return failure
    const current = panes.find(p => p.pane_id === pane.pane_id)
    if (JSON.stringify(current) !== JSON.stringify(pane)) {
      return { status: 'stale', reason: 'pane_changed' }
    }
    return undefined
  }

  private readiness(row: BindingRow): Runtime {
    if (row.delivery_kind === 'none') {
      return { status: 'not_ready', reason: 'no_delivery_transport' }
    }
    if (row.delivery_kind !== 'claude-channel' || !row.channel_session_id) {
      return { status: 'unknown', reason: 'delivery_not_probed' }
    }
    const owner = this.channels?.owner(row.channel_session_id)
    const proxy = owner && this.db.prepare(
      `SELECT 1 FROM agents WHERE agent_id = ? AND device = ?
       AND role = '__channel_proxy__' AND claude_ui_pid = ?
       AND delivery_kind = 'claude-channel'
       AND json_extract(delivery_payload,'$.channel_session_id') = ?`
    ).get(owner, this.device, row.runtime_ui_pid, row.channel_session_id)
    return proxy ? { status: 'ready', reason: 'current_channel_subscribed' }
      : { status: 'not_ready', reason: 'channel_not_subscribed' }
  }
}
