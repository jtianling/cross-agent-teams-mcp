import type Database from 'better-sqlite3'
import { AgentsRepo } from '../storage/agents-repo.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { describeRedactedError } from '../mcp/log-redact.js'
import {
  ManagedClaims, failure, fenceOf, managedToken,
  type Claim, type ManagedFailure,
} from './claims.js'
import {
  runtimeSchema, type BindInput, type ControlInput, type ManagedRuntime,
  type PrepareInput,
} from './schema.js'
import {
  canonicalRuntime, managedDelivery, sameDelivery, sameRuntimeAddress,
} from './coordinates.js'
import { verifyManagedRuntime } from './runtime.js'

export interface ManagedDeps {
  probe?: (runtime: ManagedRuntime) => Promise<ManagedFailure | undefined>
  log: (line: string) => void
}

export class ManagedService {
  readonly claims: ManagedClaims
  private readonly agents: AgentsRepo
  private readonly connections = new Map<string, string>()
  private onBound?: (token: string) => void

  setBindingListener(listener: (token: string) => void): void {
    this.onBound = listener
  }

  constructor(
    private readonly db: Database.Database,
    private readonly device: string,
    private readonly channels: ChannelWakeFanout,
    private readonly deps: ManagedDeps,
  ) {
    this.claims = new ManagedClaims(db, device)
    this.agents = new AgentsRepo(db)
  }

  prepare(input: PrepareInput) {
    const result = this.claims.prepare(input)
    if ('error' in result) return result
    return { ...this.envelope(result), mcp_token: managedToken(result) }
  }

  private envelope(claim: Claim, ready = false) {
    return {
      ok: true as const, protocol_version: 1 as const,
      fence: fenceOf(claim), state: ready ? 'ready' as const : claim.state,
      agent_id: claim.agent_id,
      runtime: claim.runtime_json
        ? runtimeSchema.parse(JSON.parse(claim.runtime_json)) : null,
    }
  }

  private registrationMatches(claim: Claim): boolean {
    if (!claim.agent_id || !claim.runtime_json) return false
    const agent = this.agents.findById(claim.agent_id)
    if (!agent) return false
    const runtime = runtimeSchema.parse(JSON.parse(claim.runtime_json))
    return agent.device === claim.device && agent.name === claim.name
      && agent.team === claim.team && agent.identity_key === claim.identity_key
      && agent.agent_type === claim.agent_type
      && sameDelivery(agent.delivery, managedDelivery(runtime))
  }

  private async probe(runtime: ManagedRuntime, key: string) {
    try {
      const result = await (this.deps.probe
        ? this.deps.probe(runtime)
        : verifyManagedRuntime(runtime, this.db, this.device, this.channels))
      if (!result) return undefined
      const detail = describeRedactedError(result.detail, key)
      this.deps.log(`managed runtime probe failed: type=${runtime.agent_type} `
        + `error=${result.error} cause=${detail}`)
      return failure(result.error, detail)
    } catch (error) {
      const detail = describeRedactedError(error, key)
      this.deps.log(`managed runtime probe failed: type=${runtime.agent_type} `
        + `cause=${detail}`)
      return failure('runtime_probe_failed', detail)
    }
  }

  async bind(input: BindInput) {
    const before = this.claims.check(input)
    if ('error' in before) return before
    const runtime = canonicalRuntime(input.runtime)
    if (before.state === 'released') {
      return failure('released', 'Claim has been released')
    }
    if (before.agent_type !== runtime.agent_type) {
      return failure('runtime_conflict', 'Runtime type does not match claim')
    }
    const failed = await this.probe(runtime, input.identity_key)
    if (failed) return failed
    const result = this.db.transaction(() =>
      this.commitBind(input, runtime)).immediate()
    if (!('error' in result)) this.onBound?.(managedToken(before))
    return result
  }

  private commitBind(input: BindInput, runtime: ManagedRuntime) {
    const row = this.claims.check(input)
    if ('error' in row) return row
    if (row.state === 'released') return failure('released', 'Claim was released')
    const serialized = JSON.stringify(runtime)
    if (row.runtime_json && row.runtime_json !== serialized) {
      return failure('runtime_conflict', 'Instance already has other coordinates')
    }
    const conflict = this.runtimeConflict(runtime, row.agent_id)
    if (conflict) return conflict
    const existing = this.agents.findByIdentity({
      device: this.device, name: row.name, team: row.team,
    })
    if (existing && existing.agent_id !== row.agent_id) {
      return failure('identity_conflict', 'Registration changed during bind')
    }
    if (row.state === 'bound') {
      return this.registrationMatches(row) ? this.envelope(row)
        : failure('registration_drift', 'Managed registration changed')
    }
    const agent = this.agents.register({
      device: this.device, name: row.name, team: row.team,
      agent_type: row.agent_type, identity_key: row.identity_key,
      delivery: managedDelivery(runtime),
      runtime_ui_pid: runtime.agent_type === 'claude-code'
        ? runtime.ui_pid : undefined,
    })
    this.db.prepare(
      `UPDATE managed_claims SET state = 'bound', runtime_json = ?,
       agent_id = ? WHERE claim_id = ?`
    ).run(serialized, agent.agent_id, row.claim_id)
    return this.envelope({ ...row, state: 'bound', runtime_json: serialized,
      agent_id: agent.agent_id })
  }

  private runtimeConflict(runtime: ManagedRuntime, own: string | null) {
    const delivery = managedDelivery(runtime)
    const rows = this.db.prepare(
      `SELECT agent_id FROM agents WHERE device = ? AND delivery_kind = ?
       AND role != '__channel_proxy__'`
    ).all(this.device, delivery.kind) as Array<{ agent_id: string }>
    const conflict = rows.some(({ agent_id }) => {
      if (agent_id === own) return false
      const other = this.agents.findById(agent_id)?.delivery
      return other !== undefined && sameRuntimeAddress(other, delivery)
    })
    return conflict ? failure('runtime_conflict', 'Runtime already registered')
      : undefined
  }

  async status(input: ControlInput & { runtime?: ManagedRuntime }) {
    const row = this.claims.check(input)
    if ('error' in row) return row
    if (input.runtime && row.runtime_json
      !== JSON.stringify(canonicalRuntime(input.runtime))) {
      return failure('runtime_conflict', 'Expected coordinates do not match')
    }
    if (row.state !== 'bound') return this.envelope(row)
    const runtime = runtimeSchema.parse(JSON.parse(row.runtime_json!))
    const failed = await this.probe(runtime, input.identity_key)
    if (failed) return failed
    const current = this.claims.check(input)
    if ('error' in current) return current
    if (current.state !== 'bound') return this.envelope(current)
    if (!this.registrationMatches(current)) {
      return failure('registration_drift', 'Managed registration changed')
    }
    const connected = Array.from(this.connections.values())
      .includes(current.token_hash)
    return this.envelope(current, connected)
  }

  release(input: ControlInput) {
    return this.db.transaction(() => {
      const row = this.claims.check(input)
      if ('error' in row) return row
      if (row.agent_id) this.agents.deleteById(row.agent_id)
      this.db.prepare(
        `UPDATE managed_claims SET state = 'released', runtime_json = NULL,
         agent_id = NULL WHERE claim_id = ?`
      ).run(row.claim_id)
      return this.envelope({ ...row, state: 'released', runtime_json: null,
        agent_id: null })
    }).immediate()
  }

  attach(token: string, connectionId: string) {
    const row = this.claims.byToken(token)
    if (!row || row.state !== 'bound' || !row.agent_id) return undefined
    if (!this.registrationMatches(row)) return undefined
    const agent = this.agents.findById(row.agent_id)
    if (!agent) return undefined
    this.connections.set(connectionId, row.token_hash)
    return agent
  }

  detach(connectionId: string): void {
    this.connections.delete(connectionId)
  }

  proxyAuthorized(token: string | undefined, channel: string, pid?: number) {
    if (!token) return false
    const row = this.claims.byToken(token)
    if (!row?.runtime_json || row.agent_type !== 'claude-code') return false
    const runtime = runtimeSchema.parse(JSON.parse(row.runtime_json))
    return runtime.agent_type === 'claude-code'
      && runtime.channel_session_id === channel
      && (pid === undefined || runtime.ui_pid === pid)
  }

  connectionValid(token: string, connectionId: string): boolean {
    const row = this.claims.byToken(token)
    return row?.state === 'bound'
      && this.connections.get(connectionId) === row.token_hash
  }

  async bindClaudeProxy(token: string, pid: number, channel: string) {
    const row = this.claims.byToken(token)
    if (!row || row.agent_type !== 'claude-code') {
      return failure('ownership_conflict', 'No matching Claude managed claim')
    }
    return this.bind({ protocol_version: 1, identity_key: row.identity_key,
      fence: fenceOf(row), runtime: { agent_type: 'claude-code', ui_pid: pid,
        channel_session_id: channel } })
  }
}
