import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { CodexBindingRepo } from '../src/mcp/codex-binding-repo.js'
import { CodexBindingLookup } from '../src/mcp/codex-binding-lookup.js'
import { CodexLaunchReconnectService } from '../src/mcp/reconnect-codex-launch.js'
import * as threadProbe from '../src/mcp/codex-reconnect-thread.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  execFileSync: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  spawn: vi.fn(() => { throw new Error('Unexpected subprocess') }),
}))

const LAUNCH = '11111111-1111-4111-8111-111111111111'
const OLD = '22222222-2222-4222-8222-222222222222'
const NEXT = '33333333-3333-4333-8333-333333333333'
const input = { launch_id: LAUNCH, thread_id: NEXT }

describe('Codex clear reconnect by launch', () => {
  let db: ReturnType<typeof openDb>
  let agents: AgentsRepo
  let bindings: CodexBindingRepo
  let service: CodexLaunchReconnectService
  let verifyThread: ReturnType<typeof vi.fn>
  let ttyProcesses: ReturnType<typeof vi.fn>
  let agentId: string

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    agents = new AgentsRepo(db)
    bindings = new CodexBindingRepo(db)
    const registered = agents.register({
      device: 'local', name: 'tester', team: 'test', agent_type: 'codex',
      delivery: { kind: 'codex-appserver', thread_id: OLD,
        ws_url: 'ws://127.0.0.1:8799' },
    })
    agentId = registered.agent_id
    db.prepare(`UPDATE agents SET tmux_pane_id = '%22',
      runtime_ui_pid = 123, runtime_tty = 'ttys022',
      last_processed_event_id = 42 WHERE agent_id = ?`).run(agentId)
    bindings.begin('%22', LAUNCH, '2000-01-01T00:00:00.000Z')
    bindings.complete({ paneId: '%22', launchId: LAUNCH, agentId,
      runtimePid: 123, registerGeneration: registered.register_generation })
    ttyProcesses = vi.fn(async () => [
      `123 123 123 S+ codex --remote -c xats.agent_id="${LAUNCH}"`,
    ])
    const lookup = new CodexBindingLookup(bindings, 'local', {
      listPanes: async () => [{ pane_id: '%22', tty: 'ttys022' }],
      ttyProcesses,
    })
    verifyThread = vi.fn(async () => ({ ok: true as const }))
    service = new CodexLaunchReconnectService(db, 'local', {
      lookup, verifyThread,
    })
  })

  afterEach(() => { db.close(); vi.restoreAllMocks() })

  function state() {
    return {
      agents: db.prepare('SELECT * FROM agents ORDER BY agent_id').all(),
      bindings: db.prepare('SELECT * FROM codex_pane_bindings').all(),
    }
  }

  it('preserves identity and cursor while updating both thread records', async () => {
    expect(await service.reconnect(input)).toMatchObject({
      ok: true, agent_id: agentId, name: 'tester', team: 'test', thread_id: NEXT,
    })
    expect(agents.findById(agentId)?.delivery).toMatchObject({ thread_id: NEXT })
    expect(bindings.read('%22')).toMatchObject({ thread_id: NEXT, agent_id: agentId })
    expect(db.prepare('SELECT last_processed_event_id FROM agents').get())
      .toEqual({ last_processed_event_id: 42 })
    expect(await service.reconnect(input)).toMatchObject({ ok: true })
  })

  it('does not guess an identity for an unknown launch', async () => {
    const before = state()
    expect(await service.reconnect({ ...input, launch_id: NEXT }))
      .toMatchObject({ ok: false, error: 'not_found' })
    expect(state()).toEqual(before)
    expect(verifyThread).not.toHaveBeenCalled()
  })

  it('rejects a replaced launch or carrier', async () => {
    ttyProcesses.mockResolvedValue([`123 123 123 S+ codex -c xats.agent_id="${NEXT}"`])
    const before = state()
    expect(await service.reconnect(input)).toMatchObject({ ok: false, error: 'stale' })
    expect(state()).toEqual(before)
  })

  it('rejects duplicate launch bindings', async () => {
    bindings.begin('%23', LAUNCH, '2999-01-01T00:00:00.000Z')
    expect(await service.reconnect(input)).toMatchObject({
      ok: false, error: 'ambiguous',
    })
    expect(verifyThread).not.toHaveBeenCalled()
  })

  it.each([
    ['2999-01-01T00:00:00.000Z', 'pending'],
    ['2000-01-01T00:00:00.000Z', 'stale'],
  ])('does not recover an incomplete launch: %s', async (expiry, error) => {
    bindings.begin('%22', LAUNCH, expiry)
    const before = state()
    expect(await service.reconnect(input)).toEqual({ ok: false, error })
    expect(state()).toEqual(before)
    expect(verifyThread).not.toHaveBeenCalled()
  })

  it('does not recover another device through a local launch record', async () => {
    db.prepare("UPDATE agents SET device = 'remote'").run()
    expect(await service.reconnect(input)).toEqual({ ok: false, error: 'stale' })
    expect(verifyThread).not.toHaveBeenCalled()
  })

  it.each(['codex_thread_not_primary', 'codex_thread_read_failed'])(
    'preserves all state on %s', async error => {
      verifyThread.mockResolvedValue({ ok: false, error })
      const before = state()
      expect(await service.reconnect(input)).toEqual({ ok: false, error })
      expect(state()).toEqual(before)
    })

  it('rejects a different agent already claiming the new thread', async () => {
    agents.register({ device: 'local', name: 'other', team: 'test',
      agent_type: 'codex', delivery: { kind: 'codex-appserver',
        thread_id: NEXT, ws_url: 'ws://127.0.0.1:8799' } })
    const before = state()
    expect(await service.reconnect(input)).toMatchObject({
      ok: false, error: 'codex_thread_conflict',
    })
    expect(state()).toEqual(before)
  })

  it('rejects a launch replacement during thread verification', async () => {
    verifyThread.mockImplementation(async () => {
      bindings.begin('%22', NEXT, '2999-01-01T00:00:00.000Z')
      return { ok: true }
    })
    expect(await service.reconnect(input)).toMatchObject({ ok: false, error: 'stale' })
    expect(agents.findById(agentId)?.delivery).toMatchObject({ thread_id: OLD })
    expect(bindings.read('%22')).toMatchObject({ launch_id: NEXT, thread_id: null })
  })

  it('rejects concurrent re-registration even when the thread stays the same',
    async () => {
      verifyThread.mockImplementation(async () => {
        db.prepare('UPDATE agents SET register_generation = register_generation + 1')
          .run()
        return { ok: true }
      })
      expect(await service.reconnect(input)).toMatchObject({
        ok: false, error: 'stale',
      })
      expect(agents.findById(agentId)?.delivery).toMatchObject({ thread_id: OLD })
    })

  it('rolls back the agent update when binding persistence fails', async () => {
    vi.spyOn(CodexBindingRepo.prototype, 'complete').mockImplementation(() => {
      throw new Error('Simulated storage failure')
    })
    const before = state()
    await expect(service.reconnect(input)).rejects.toThrow('Simulated storage failure')
    expect(state()).toEqual(before)
  })

  async function withMcp(run: (
    client: Client, bound: () => string, register: RegisterAgentService,
    closed: string[]
  ) => Promise<void>) {
    const server = new McpServer({ name: 'test', version: '1' })
    const client = new Client({ name: 'codex', version: '1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    let bound = ''
    const closed: string[] = []
    const register = new RegisterAgentService(db, {
      closeSessionByConnectionId: id => { closed.push(id); return true },
    })
    register.bindExistingConnection({
      connection_id: 'old-session', agent_type: 'codex', device: 'local',
      team: 'test', name: 'tester', delivery: { kind: 'codex-appserver',
        thread_id: OLD, ws_url: 'ws://127.0.0.1:8799' },
    })
    registerBusinessTools(server, db, () => bound || undefined, undefined,
      id => { bound = id }, () => 'test-session', undefined, undefined,
      undefined, undefined, undefined, undefined, register)
    await server.connect(st)
    await client.connect(ct)
    try { await run(client, () => bound, register, closed) } finally {
      await client.close()
      await server.close()
    }
  }

  it('reconnects through MCP and binds the recovered mailbox identity', async () => {
    vi.spyOn(threadProbe, 'verifyCodexReconnectThread').mockResolvedValue({ ok: true })
    vi.spyOn(CodexBindingLookup.prototype, 'lookup').mockResolvedValue({
      ok: true, protocol_version: 1, pane_id: '%22', launch_id: LAUNCH,
      thread_id: OLD,
    })
    await withMcp(async (client, bound, _register, closed) => {
      const response = await client.callTool({ name: 'reconnect', arguments: input })
      const data = JSON.parse((response.content as Array<{ text: string }>)[0].text)
      expect(data).toMatchObject({ ok: true, agent_id: agentId, thread_id: NEXT })
      expect(data).not.toHaveProperty('delivery')
      expect(data).not.toHaveProperty('identity_key')
      expect(bound()).toBe(agentId)
      expect(closed).toEqual(['old-session'])
      expect(bindings.read('%22')?.thread_id).toBe(NEXT)
    })
  })

  it('does not let a committed older request close a newer connection', async () => {
    vi.spyOn(threadProbe, 'verifyCodexReconnectThread').mockResolvedValue({ ok: true })
    vi.spyOn(CodexBindingLookup.prototype, 'lookup').mockResolvedValue({
      ok: true, protocol_version: 1, pane_id: '%22', launch_id: LAUNCH,
      thread_id: OLD,
    })
    await withMcp(async (client, bound, register, closed) => {
      const complete = CodexBindingRepo.prototype.complete
      let injected = false
      vi.spyOn(CodexBindingRepo.prototype, 'complete').mockImplementation(function (
        this: CodexBindingRepo, args
      ) {
        complete.call(this, args)
        if (injected) return
        injected = true
        queueMicrotask(() => {
          const delivery = { kind: 'codex-appserver' as const,
            thread_id: OLD, ws_url: 'ws://127.0.0.1:8799' }
          const result = agents.register({
            agent_type: 'codex', device: 'local', team: 'test', name: 'tester',
            delivery,
          })
          bindings.complete({ paneId: '%22', launchId: LAUNCH, agentId,
            runtimePid: 123, registerGeneration: result.register_generation })
          register.bindExistingConnection({
            connection_id: 'newer-session', agent_type: 'codex', device: 'local',
            name: 'tester', team: 'test', delivery,
          })
        })
      })
      const response = await client.callTool({ name: 'reconnect', arguments: input })
      const data = JSON.parse((response.content as Array<{ text: string }>)[0].text)
      expect(data).toEqual({ ok: false, error: 'stale' })
      expect(bound()).toBe('')
      expect(closed).not.toContain('newer-session')
      expect(bindings.read('%22')?.thread_id).toBe(OLD)
    })
  })

  it('rejects mixed launch lookup keys at the MCP boundary', async () => {
    await withMcp(async client => {
      for (const args of [
        { launch_id: LAUNCH }, { ...input, launch_id: 'bad' },
        { ...input, identity_key: 'foreign' }, { ...input, ui_pid: 123 },
        { ...input, base_url: 'http://localhost:1' },
      ]) {
        expect(await client.callTool({ name: 'reconnect', arguments: args }))
          .toMatchObject({ isError: true })
      }
      expect(agents.findById(agentId)?.delivery).toMatchObject({ thread_id: OLD })
    })
  })
})
