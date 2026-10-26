import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { ManagedService } from '../src/managed/service.js'
import {
  bindSchema, type ControlInput, type ManagedRuntime, type PrepareInput,
} from '../src/managed/schema.js'

describe('managed instance ownership', () => {
  let db: Database.Database
  let service: ManagedService
  const probe = vi.fn(async (_runtime: ManagedRuntime) => undefined)
  const channels = new ChannelWakeFanout()
  const request = (): PrepareInput => ({
    protocol_version: 1, identity_key: randomUUID(), instance_id: randomUUID(),
    name: 'worker', team: 'project', agent_type: 'codex',
  })
  const runtime = (): ManagedRuntime => ({
    agent_type: 'codex', thread_id: randomUUID(), ws_url: 'ws://127.0.0.1:8799/',
  })
  const prepare = (input = request()) => {
    const result = service.prepare(input)
    if (!result.ok) throw new Error(result.error)
    const control: ControlInput = { protocol_version: 1,
      identity_key: input.identity_key, fence: result.fence }
    return { input, result, control }
  }

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    probe.mockClear()
    service = new ManagedService(db, 'local', channels, { probe, log: vi.fn() })
  })
  afterEach(() => db.close())

  it('reserves a new identity and makes exact prepare retries idempotent', () => {
    const { input, result } = prepare()
    expect(service.prepare(input)).toEqual(result)
    expect(result.agent_id).toBeNull()
    expect(result.runtime).toBeNull()
    expect(service.prepare({ ...input, identity_key: randomUUID() }))
      .toMatchObject({ ok: false, error: 'identity_conflict' })
  })

  it('rejects legacy registration into a prepared managed identity', () => {
    prepare()
    const legacy = new RegisterAgentService(db)
    expect(legacy.register({ connection_id: 'legacy', name: 'worker',
      team: 'project', agent_type: 'custom', agent_type_name: 'test' }))
      .toEqual({ error: 'agent_id_collision' })
  })

  it('requires a matching live connection before reporting ready', async () => {
    const { result, control } = prepare()
    const coordinates = runtime()
    expect(await service.bind({ ...control, runtime: coordinates }))
      .toMatchObject({ ok: true, state: 'bound' })
    expect(await service.status(control)).toMatchObject({ state: 'bound' })
    expect(service.attach(result.mcp_token, 'connection')).toBeDefined()
    expect(await service.status(control)).toMatchObject({ state: 'ready' })
    service.detach('connection')
    expect(await service.status(control)).toMatchObject({ state: 'bound' })
  })

  it.each(['opencode', 'kimi-code'] as const)(
    'compares %s coordinates without depending on JSON field order', async type => {
      const { control, result } = prepare({ ...request(), agent_type: type })
      const coordinates: ManagedRuntime = { agent_type: type,
        base_url: 'http://127.0.0.1:1234/', session_id: 'session-1' }
      expect(await service.bind({ ...control, runtime: coordinates }))
        .toMatchObject({ state: 'bound' })
      expect(service.attach(result.mcp_token, 'connection')).toBeDefined()
      expect(await service.status(control)).toMatchObject({ state: 'ready' })
    }
  )

  it('fences old control operations and connections before restarting', async () => {
    const { input, control, result } = prepare()
    await service.bind({ ...control, runtime: runtime() })
    service.attach(result.mcp_token, 'old')
    const next = { ...input, instance_id: randomUUID(), previous: result.fence }
    const restarted = service.prepare(next)
    expect(restarted).toMatchObject({ state: 'prepared',
      fence: { generation: 2 } })
    expect(service.prepare(next)).toEqual(restarted)
    expect(service.connectionValid(result.mcp_token, 'old')).toBe(false)
    expect(service.release(control)).toMatchObject({ error: 'stale_fence' })
    expect(await service.bind({ ...control, runtime: runtime() }))
      .toMatchObject({ error: 'stale_fence' })
  })

  it('rejects a probe result that returns after the generation changes', async () => {
    let resolve: (() => void) | undefined
    const delayed = new ManagedService(db, 'local', channels, {
      log: vi.fn(), probe: async () => {
        await new Promise<void>(done => { resolve = done })
        return undefined
      },
    })
    const { input, result, control } = prepare()
    const binding = delayed.bind({ ...control, runtime: runtime() })
    service.prepare({ ...input, instance_id: randomUUID(), previous: result.fence })
    resolve!()
    expect(await binding).toMatchObject({ error: 'stale_fence' })
    expect(db.prepare('SELECT count(*) AS count FROM agents').get())
      .toEqual({ count: 0 })
  })

  it('does not resurrect a released instance through a replayed prepare', () => {
    const { input, control } = prepare()
    expect(service.release(control)).toMatchObject({ state: 'released' })
    expect(service.release(control)).toMatchObject({ state: 'released' })
    expect(service.prepare(input)).toMatchObject({ error: 'stale_fence' })
    expect(service.prepare({ ...request(), instance_id: randomUUID() }))
      .toMatchObject({ state: 'prepared' })
    expect(service.release(control)).toMatchObject({ state: 'released' })
  })

  it('rejects reuse of any prior instance ID in a later generation', () => {
    const { input, result } = prepare()
    const second = service.prepare({ ...input,
      instance_id: randomUUID(), previous: result.fence })
    if (!second.ok) throw new Error(second.error)
    expect(service.prepare({ ...input, previous: second.fence }))
      .toMatchObject({ error: 'stale_fence' })
  })

  it('does not reclaim an identity occupied after release', () => {
    const { input, control, result } = prepare()
    service.release(control)
    new AgentsRepo(db).register({ name: input.name, team: input.team,
      agent_type: 'custom', agent_type_name: 'replacement' })
    expect(service.prepare({ ...input, instance_id: randomUUID(),
      previous: result.fence })).toMatchObject({ error: 'identity_conflict' })
    expect(service.claims.byId(result.fence.claim_id))
      .toMatchObject({ state: 'released', generation: 1 })
  })

  it('blocks legacy registrations from evicting a managed thread', async () => {
    const { control } = prepare()
    const coordinates = runtime()
    if (coordinates.agent_type !== 'codex') throw new Error('Expected codex')
    await service.bind({ ...control, runtime: coordinates })
    const legacy = new RegisterAgentService(db)
    expect(legacy.register({ connection_id: 'legacy', name: 'other',
      team: 'project', agent_type: 'codex', delivery: {
        kind: 'codex-appserver', thread_id: coordinates.thread_id,
        ws_url: coordinates.ws_url,
      } })).toMatchObject({ error: 'agent_id_collision' })
    expect(await service.status(control)).toMatchObject({ state: 'bound' })
  })

  it('treats equivalent OpenCode URLs as the same occupied runtime', async () => {
    const { control } = prepare({ ...request(), agent_type: 'opencode' })
    await service.bind({ ...control, runtime: { agent_type: 'opencode',
      base_url: 'http://localhost', session_id: 'session-1' } })
    const legacy = new RegisterAgentService(db)
    expect(legacy.register({ connection_id: 'legacy', name: 'other',
      team: 'project', agent_type: 'opencode', delivery: {
        kind: 'opencode-server', base_url: 'http://LOCALHOST:80/',
        session_id: 'session-1',
      } })).toMatchObject({ error: 'agent_id_collision' })
  })

  it('keeps managed Claude coordinates when a different proxy registers', async () => {
    const { control } = prepare({ ...request(), agent_type: 'claude-code' })
    const coordinates: ManagedRuntime = { agent_type: 'claude-code',
      ui_pid: 1234, channel_session_id: 'original-channel' }
    const bound = await service.bind({ ...control, runtime: coordinates })
    if (!bound.ok) throw new Error(bound.error)
    const agents = new AgentsRepo(db)
    agents.register({ name: 'other-proxy', team: 'project',
      role: '__channel_proxy__', claude_ui_pid: 1234,
      delivery: { kind: 'claude-channel', channel_session_id: 'new-channel' } })
    expect(agents.findById(bound.agent_id!)?.delivery).toEqual({
      kind: 'claude-channel', channel_session_id: 'original-channel',
    })
  })

  it('detects registration drift instead of reporting false ready', async () => {
    const { control, result } = prepare()
    const bound = await service.bind({ ...control, runtime: runtime() })
    if (!bound.ok) throw new Error(bound.error)
    service.attach(result.mcp_token, 'connection')
    db.prepare("UPDATE agents SET delivery_kind = 'none' WHERE agent_id = ?")
      .run(bound.agent_id)
    expect(await service.status(control))
      .toMatchObject({ error: 'registration_drift' })
  })

  it('returns invalid URL validation errors without throwing', () => {
    const { control } = prepare()
    expect(bindSchema.safeParse({ ...control, runtime: {
      agent_type: 'opencode', base_url: 'not-a-url', session_id: 'session-1',
    } }).success).toBe(false)
    for (const base_url of ['http://localhost/?', 'http://localhost/#']) {
      expect(bindSchema.safeParse({ ...control, runtime: {
        agent_type: 'opencode', base_url, session_id: 'session-1',
      } }).success).toBe(false)
    }
  })
})
