import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { parseDeliveryRow, serializeDelivery } from '../lib/delivery-spec.js'
import { managedDelivery, canonicalRuntime, sameRuntimeAddress }
  from '../managed/coordinates.js'
import { managedIdentityExists, managedDeliveryExists } from '../managed/guard.js'
import { verifyManagedRuntime } from '../managed/runtime.js'
import type { ManagedRuntime } from '../managed/schema.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { AutoBindChannelService } from '../mcp/auto-bind-channel.js'
import { clearCodexRecoveryNoncesForPane } from '../mcp/codex-recovery-nonce.js'
import { describeRedactedError } from '../mcp/log-redact.js'
import { HandoffRepo, keyHash, type HandoffRow, type SourceRow } from './repo.js'
import { exactHandoffDelivery, handoffEpoch } from './guard.js'
import { handoffFailure, type PrepareHandoff, type HandoffControl,
  type CommitHandoff } from './schema.js'

export interface HandoffDeps {
  probe?: (runtime: ManagedRuntime) => Promise<
    { error: string; detail: string } | undefined>
  log: (message: string) => void
}

function publicSource(row: SourceRow | undefined) {
  if (!row) return null
  const delivery = parseDeliveryRow(row)
  let runtime: ManagedRuntime | null = null
  if (delivery.kind === 'codex-appserver') {
    runtime = { agent_type: 'codex', thread_id: delivery.thread_id,
      ws_url: delivery.ws_url }
  } else if (delivery.kind === 'opencode-server') {
    runtime = { agent_type: 'opencode', base_url: delivery.base_url,
      session_id: delivery.session_id }
  } else if (delivery.kind === 'claude-channel' && row.runtime_ui_pid) {
    runtime = { agent_type: 'claude-code', ui_pid: row.runtime_ui_pid,
      channel_session_id: delivery.channel_session_id }
  }
  return { agent_id: row.agent_id, name: row.name, team: row.team,
    agent_type: row.agent_type, register_generation: row.register_generation,
    runtime_generation: row.agent_type === 'opencode'
      ? row.opencode_runtime_generation : null, runtime }
}

export class RuntimeHandoffService {
  private readonly repo: HandoffRepo

  constructor(private readonly db: Database.Database,
    private readonly device: string, private readonly channels: ChannelWakeFanout,
    private readonly deps: HandoffDeps,
  ) { this.repo = new HandoffRepo(db, device) }

  prepare(input: PrepareHandoff) {
    return this.db.transaction(() => {
      const config = JSON.stringify({ name: input.name, team: input.team,
        source_agent_type: input.source_agent_type,
        target_agent_type: input.target_agent_type,
        expected_source: input.expected_source ?? null })
      const existing = this.repo.request(input.request_id)
      if (existing) {
        if (existing.identity_hash !== keyHash(input.identity_key)
          || existing.config_json !== config) {
          return handoffFailure('request_conflict', 'Request ID is already used')
        }
        return this.envelope(existing, input.identity_key)
      }
      const source = this.repo.source(input.identity_key)
      if (!source) return handoffFailure('not_found', 'Identity key not found')
      if (managedIdentityExists(this.db, { device: this.device,
        identity_key: input.identity_key })) {
        return handoffFailure('managed_control_required', 'Use managed prepare')
      }
      if (source.name !== input.name || source.team !== input.team
        || source.agent_type !== input.source_agent_type) {
        return handoffFailure('source_mismatch', 'Source identity does not match')
      }
      if (!this.expectedSource(source, input)) {
        return handoffFailure('source_mismatch', 'Source runtime does not match')
      }
      if (this.repo.pending(source.agent_id)) {
        return handoffFailure('handoff_in_progress', 'Another handoff is pending')
      }
      const row: HandoffRow = { handoff_id: randomUUID(), device: this.device,
        identity_hash: keyHash(input.identity_key), request_id: input.request_id,
        agent_id: source.agent_id, config_json: config,
        source_json: JSON.stringify(source), target_type: input.target_agent_type,
        state: 'prepared', runtime_json: null, committed_generation: null,
        source_launch_id: (this.db.prepare(`SELECT launch_id
          FROM codex_pane_bindings WHERE pane_id=? AND agent_id=?`)
          .get(source.tmux_pane_id, source.agent_id) as
          { launch_id: string } | undefined)?.launch_id ?? null }
      this.repo.save(row)
      return this.envelope(row, input.identity_key)
    }).immediate()
  }

  private expectedSource(source: SourceRow, input: PrepareHandoff): boolean {
    const expected = input.expected_source
    const runtime = publicSource(source)?.runtime
    if (expected?.pane_id && source.tmux_pane_id !== expected.pane_id) return false
    if (expected?.thread_id && (runtime?.agent_type !== 'codex'
      || runtime.thread_id !== expected.thread_id)) return false
    if (!expected?.launch_id) return true
    const binding = this.db.prepare(`SELECT agent_id, launch_id, thread_id
      FROM codex_pane_bindings WHERE pane_id=?`).get(source.tmux_pane_id) as
      { agent_id: string; launch_id: string; thread_id: string } | undefined
    return binding?.agent_id === source.agent_id
      && binding.launch_id === expected.launch_id
      && runtime?.agent_type === 'codex'
      && binding.thread_id === runtime.thread_id
  }

  private check(input: HandoffControl) {
    const row = this.repo.get(input.fence.handoff_id)
    if (!row || row.identity_hash !== keyHash(input.identity_key)) {
      return handoffFailure('not_found', 'Handoff not found')
    }
    const source = JSON.parse(row.source_json) as SourceRow
    if (source.register_generation !== input.fence.register_generation) {
      return handoffFailure('stale_fence', 'Register fence does not match')
    }
    return row
  }

  status(input: HandoffControl) {
    return this.db.transaction(() => {
      const row = this.check(input)
      return 'error' in row ? row : this.envelope(row, input.identity_key)
    }).immediate()
  }

  abort(input: HandoffControl) {
    return this.db.transaction(() => {
      const row = this.check(input)
      if ('error' in row) return row
      if (row.committed_generation !== null) {
        return handoffFailure('already_committed', 'Committed handoff cannot abort')
      }
      this.repo.state(row.handoff_id, 'aborted')
      return this.envelope({ ...row, state: 'aborted' }, input.identity_key)
    }).immediate()
  }

  async commit(input: CommitHandoff) {
    const row = this.check(input)
    if ('error' in row) return row
    if (input.runtime.agent_type !== row.target_type) {
      return handoffFailure('target_mismatch', 'Runtime does not match target type')
    }
    if (row.state !== 'prepared' && row.state !== 'committed') {
      return handoffFailure('stale_fence', 'Handoff is not pending')
    }
    if (row.state === 'committed') {
      const stored = JSON.parse(row.runtime_json!) as ManagedRuntime
      const runtime = canonicalRuntime(input.runtime.agent_type === 'claude-code'
        && stored.agent_type === 'claude-code' ? { ...input.runtime,
          channel_session_id: input.runtime.channel_session_id
            ?? stored.channel_session_id } : input.runtime as ManagedRuntime)
      if (row.runtime_json !== JSON.stringify(runtime)) {
        return handoffFailure('runtime_conflict', 'Handoff committed other runtime')
      }
      return this.envelope(row, input.identity_key)
    }
    const runtime = this.resolveRuntime(input.runtime)
    if ('error' in runtime) return runtime
    const failed = await this.probe(runtime, input.identity_key)
    if (failed) return failed
    return this.db.transaction(() => this.finish(input, runtime)).immediate()
  }

  private resolveRuntime(input: CommitHandoff['runtime']) {
    if (input.agent_type !== 'claude-code') return canonicalRuntime(input)
    const found = new AutoBindChannelService(this.db, this.channels)
      .lookup({ ui_pid: input.ui_pid, device: this.device })
    if (!found.ok || (input.channel_session_id !== undefined
      && input.channel_session_id !== found.channel_session_id)) {
      return handoffFailure('runtime_probe_failed',
        'No matching Claude channel proxy', true)
    }
    return canonicalRuntime({ ...input,
      channel_session_id: found.channel_session_id })
  }

  private async probe(runtime: ManagedRuntime, key: string) {
    try {
      const failed = await (this.deps.probe ? this.deps.probe(runtime)
        : verifyManagedRuntime(runtime, this.db, this.device, this.channels))
      if (!failed) return undefined
      const detail = describeRedactedError(failed.detail, key)
      this.deps.log(`runtime handoff probe failed: ${failed.error}: ${detail}`)
      return handoffFailure('runtime_probe_failed', detail, true)
    } catch (error) {
      const detail = describeRedactedError(error, key)
      this.deps.log(`runtime handoff probe failed: ${detail}`)
      return handoffFailure('runtime_probe_failed', detail, true)
    }
  }

  private finish(input: CommitHandoff, runtime: ManagedRuntime) {
    const row = this.check(input)
    if ('error' in row) return row
    if (row.state === 'committed' && row.runtime_json === JSON.stringify(runtime)) {
      return this.envelope(row, input.identity_key)
    }
    const source = this.repo.source(input.identity_key)
    if (row.state !== 'prepared' || JSON.stringify(source) !== row.source_json
      || managedIdentityExists(this.db, { device: this.device,
        identity_key: input.identity_key })) {
      return handoffFailure('stale_fence', 'Source changed during handoff')
    }
    const delivery = managedDelivery(runtime)
    const occupied = this.db.prepare(`SELECT agent_id, delivery_kind,
      delivery_payload FROM agents WHERE device=? AND agent_id!=?
      AND role!='__channel_proxy__'`).all(this.device, source!.agent_id) as
      Array<{ delivery_kind: string; delivery_payload: string | null }>
    if (managedDeliveryExists(this.db, this.device, delivery)
      || occupied.some(other => sameRuntimeAddress(parseDeliveryRow(other), delivery))) {
      return handoffFailure('runtime_conflict', 'Target runtime already owned')
    }
    if (source!.register_generation >= Number.MAX_SAFE_INTEGER
      || source!.opencode_runtime_generation >= Number.MAX_SAFE_INTEGER) {
      return handoffFailure('generation_exhausted', 'Generation cannot advance')
    }
    const nextGeneration = source!.opencode_runtime_generation + 1
    const serialized = serializeDelivery(delivery.kind === 'opencode-server'
      ? { ...delivery, runtime_generation: nextGeneration } : delivery)
    this.db.prepare(`UPDATE agents SET agent_type=?, agent_type_name=NULL,
      delivery_kind=?, delivery_payload=?, register_generation=register_generation+1,
      opencode_runtime_generation=?, tmux_pane_id=NULL, prev_tmux_pane_id=NULL,
      prev_codex_thread_id=NULL, runtime_ui_pid=?, claude_ui_pid=NULL,
      runtime_tty=NULL, runtime_verification_mode=NULL, runtime_bound_at=NULL,
      channel_session_id=NULL WHERE agent_id=?`).run(runtime.agent_type,
      serialized.delivery_kind, serialized.delivery_payload, nextGeneration,
      runtime.agent_type === 'claude-code' ? runtime.ui_pid : null, row.agent_id)
    const generation = source!.register_generation + 1
    this.db.prepare(`UPDATE runtime_handoffs SET state='committed',
      runtime_json=?, committed_generation=? WHERE handoff_id=?`)
      .run(JSON.stringify(runtime), generation, row.handoff_id)
    if (source!.tmux_pane_id && row.source_launch_id) {
      clearCodexRecoveryNoncesForPane(source!.tmux_pane_id, row.source_launch_id)
    }
    return this.envelope({ ...row, state: 'committed',
      runtime_json: JSON.stringify(runtime), committed_generation: generation },
    input.identity_key)
  }

  private envelope(row: HandoffRow, key: string) {
    const source = JSON.parse(row.source_json) as SourceRow
    const current = this.repo.source(key)
    const stale = row.state === 'prepared'
      ? JSON.stringify(current) !== row.source_json
      : row.state === 'committed' && (current?.agent_id !== row.agent_id
        || current.agent_type !== row.target_type
        || handoffEpoch(this.db, row.agent_id) !== row.committed_generation
        || current.register_generation < row.committed_generation!
        || !exactHandoffDelivery(parseDeliveryRow(current),
          managedDelivery(JSON.parse(row.runtime_json!) as ManagedRuntime)))
    if (stale) this.repo.state(row.handoff_id, 'stale')
    return { ok: true as const, protocol_version: 1 as const,
      state: stale ? 'stale' as const : row.state,
      fence: { handoff_id: row.handoff_id,
        register_generation: source.register_generation },
      source: publicSource(source)!, current: publicSource(current),
      target_agent_type: row.target_type, recovery_prompt: null }
  }
}
