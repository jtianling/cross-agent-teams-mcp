import type Database from 'better-sqlite3'
import { AgentsRepo, type AgentRow } from '../storage/agents-repo.js'
import { CodexBindingRepo, type CodexBindingRow } from './codex-binding-repo.js'
import { CodexBindingLookup } from './codex-binding-lookup.js'
import { verifyCodexReconnectThread } from './codex-reconnect-thread.js'

type Input = {
  launch_id: string
  thread_id: string
  ws_url?: string
  auth_token_ref?: string
}
type Failure = { ok: false; error: string }
type Snapshot = { binding: CodexBindingRow; agent: AgentRow; generation: number }
type Committed = {
  agent_id: string
  launch_id: string
  pane_id: string
  thread_id: string
  register_generation: number
}

export class CodexLaunchReconnectService {
  private readonly agents: AgentsRepo
  private readonly bindings: CodexBindingRepo
  private readonly lookup: CodexBindingLookup

  constructor(
    private readonly db: Database.Database,
    private readonly localDevice: string,
    private readonly deps: {
      lookup?: CodexBindingLookup
      verifyThread?: typeof verifyCodexReconnectThread
    } = {}
  ) {
    this.agents = new AgentsRepo(db)
    this.bindings = new CodexBindingRepo(db)
    this.lookup = deps.lookup ?? new CodexBindingLookup(this.bindings, localDevice)
  }

  async reconnect(input: Input) {
    const snapshot = this.capture(input.launch_id)
    if ('ok' in snapshot) return snapshot
    const { binding, agent } = snapshot
    const delivery = agent.delivery
    if (delivery.kind !== 'codex-appserver') return this.fail('stale')
    if ((input.ws_url !== undefined && input.ws_url !== delivery.ws_url)
      || (input.auth_token_ref !== undefined
        && input.auth_token_ref !== delivery.auth_token_ref)) {
      return this.fail('codex_endpoint_mismatch')
    }
    const coordinates = { protocol_version: 1 as const,
      pane_id: binding.pane_id, launch_id: input.launch_id }
    const initial = await this.lookup.lookup(coordinates)
    if (!initial.ok) return initial
    const verified = await (this.deps.verifyThread ?? verifyCodexReconnectThread)(
      delivery, input.thread_id
    )
    if (!verified.ok) return verified
    const final = await this.lookup.lookup(coordinates)
    if (!final.ok) return final
    return this.db.transaction(() => this.commit(snapshot, input.thread_id))()
  }

  isCurrent(result: Committed): boolean {
    const current = this.capture(result.launch_id)
    return !('ok' in current)
      && current.generation === result.register_generation
      && current.agent.agent_id === result.agent_id
      && current.binding.pane_id === result.pane_id
      && current.binding.thread_id === result.thread_id
      && this.bindings.matchesAgent(current.binding, this.localDevice)
  }

  private capture(launchId: string): Snapshot | Failure {
    const rows = this.bindings.findByLaunchId(launchId)
    if (rows.length === 0) return this.fail('not_found')
    if (rows.length !== 1) return this.fail('ambiguous')
    const binding = rows[0]
    if (!binding.agent_id) {
      return this.fail(binding.expires_at > new Date().toISOString()
        ? 'pending' : 'stale')
    }
    const agent = this.agents.findById(binding.agent_id)
    if (!agent || agent.device !== this.localDevice
      || agent.role === '__channel_proxy__'
      || agent.agent_type !== 'codex') return this.fail('stale')
    const row = this.db.prepare(
      'SELECT register_generation FROM agents WHERE agent_id = ?'
    ).get(agent.agent_id) as { register_generation: number }
    return { binding, agent, generation: row.register_generation }
  }

  private unchanged(snapshot: Snapshot): boolean {
    const current = this.capture(snapshot.binding.launch_id)
    if ('ok' in current) return false
    const stable = ({ agent, ...rest }: Snapshot) => ({
      ...rest, agent: { ...agent, last_seen_at: undefined },
    })
    return JSON.stringify(stable(current)) === JSON.stringify(stable(snapshot))
      && this.bindings.matchesAgent(snapshot.binding, this.localDevice)
  }

  private commit(snapshot: Snapshot, threadId: string) {
    if (!this.unchanged(snapshot)) return this.fail('stale')
    const { agent, binding } = snapshot
    if (agent.delivery.kind !== 'codex-appserver') return this.fail('stale')
    const conflicts = this.agents.findByCodexThreadId(threadId, this.localDevice)
    if (conflicts.some(row => row.agent_id !== agent.agent_id)) {
      return this.fail('codex_thread_conflict')
    }
    const delivery = { ...agent.delivery, thread_id: threadId }
    const result = this.agents.register({
      agent_type: 'codex', device: agent.device, team: agent.team,
      name: agent.name, role: agent.role, model: agent.model ?? undefined,
      delivery,
    })
    this.bindings.complete({
      paneId: binding.pane_id, launchId: binding.launch_id,
      agentId: result.agent_id, runtimePid: binding.runtime_ui_pid!,
      registerGeneration: result.register_generation,
    })
    return {
      ok: true as const, agent_id: result.agent_id, name: agent.name,
      team: result.team, device: agent.device, delivery,
      thread_id: threadId, ws_url: delivery.ws_url,
      launch_id: binding.launch_id, pane_id: binding.pane_id,
      register_generation: result.register_generation,
    }
  }

  private fail(error: string): Failure {
    return { ok: false, error }
  }
}
