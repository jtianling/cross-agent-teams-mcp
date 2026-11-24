import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { managedDelivery } from '../src/managed/coordinates.js'
import type { ManagedRuntime } from '../src/managed/schema.js'
import { RuntimeHandoffService } from '../src/handoff/service.js'
import { handoffEpoch } from '../src/handoff/guard.js'
import { BindChannelService } from '../src/mcp/bind-channel.js'
import { SubscribeChannelWakeService } from '../src/mcp/subscribe-channel-wake.js'
import { prepareHandoffSchema, type PrepareHandoff,
  type HandoffControl } from '../src/handoff/schema.js'

const key = 'isolated-runtime-handoff-key'
const types = ['codex', 'claude-code', 'opencode'] as const
type RuntimeType = typeof types[number]
const runtime = (type: RuntimeType):
  Exclude<ManagedRuntime, { agent_type: 'kimi-code' }> => {
  if (type === 'codex') return { agent_type: type, thread_id: randomUUID(),
    ws_url: 'ws://127.0.0.1:8799/' }
  if (type === 'opencode') return { agent_type: type,
    base_url: 'http://127.0.0.1:12121', session_id: `ses_${randomUUID()}` }
  return { agent_type: type, ui_pid: process.pid,
    channel_session_id: 'isolated-channel' }
}

describe('runtime type handoff', () => {
  let db: ReturnType<typeof openDb>
  let repo: AgentsRepo
  let service: RuntimeHandoffService
  const probe = vi.fn(async (_runtime: ManagedRuntime) => undefined)
  const log = vi.fn()

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    repo = new AgentsRepo(db)
    probe.mockClear()
    service = new RuntimeHandoffService(db, 'local', new ChannelWakeFanout(),
      { probe, log })
    repo.register({ device: 'local', name: 'proxy', role: '__channel_proxy__',
      claude_ui_pid: process.pid, delivery: {
        kind: 'claude-channel', channel_session_id: 'isolated-channel' } })
  })
  afterEach(() => db.close())

  function setup(source: RuntimeType = 'codex', target: RuntimeType = 'opencode') {
    const original = runtime(source)
    const registered = repo.register({ name: 'worker', team: 'project',
      device: 'local', agent_type: source, identity_key: key,
      runtime_ui_pid: source === 'claude-code' ? process.pid : undefined,
      delivery: managedDelivery(original) })
    const input: PrepareHandoff = { protocol_version: 1, identity_key: key,
      request_id: randomUUID(), name: 'worker', team: 'project',
      source_agent_type: source, target_agent_type: target }
    const prepared = service.prepare(input)
    if (!prepared.ok) throw new Error(prepared.error)
    const control: HandoffControl = { protocol_version: 1,
      identity_key: key, fence: prepared.fence }
    return { input, prepared, control, original, id: registered.agent_id }
  }

  it.each(types.flatMap(source => types.filter(target => target !== source)
    .map(target => [source, target] as const)))(
    'preserves identity and cursor switching %s to %s', async (source, target) => {
      const h = setup(source, target)
      db.prepare('UPDATE agents SET last_processed_event_id=73 WHERE agent_id=?')
        .run(h.id)
      const coordinates = runtime(target)
      const result = await service.commit({ ...h.control, runtime: coordinates })
      expect(result).toMatchObject({ ok: true, state: 'committed',
        current: { agent_id: h.id, agent_type: target }, recovery_prompt: null })
      expect(repo.findOpencodeRuntimeByIdentityKey(key, 'local'))
        .toMatchObject({ agent_id: h.id, last_processed_event_id: 73,
          identity_key: key, name: 'worker', team: 'project',
          register_generation: h.prepared.source.register_generation + 1 })
      expect(await service.commit({ ...h.control, runtime: coordinates }))
        .toEqual(result)
      expect(service.abort(h.control)).toMatchObject({ error: 'already_committed' })
      expect(JSON.stringify(result)).not.toContain(key)
      expect(handoffEpoch(db, h.id)).toBeGreaterThan(0)
    }
  )

  it('does not mutate source at prepare and restores pending after reconstruction', () => {
    const h = setup()
    const before = repo.findOpencodeRuntimeByIdentityKey(key, 'local')
    expect(service.prepare(h.input)).toEqual(h.prepared)
    applySchema(db)
    const restored = new RuntimeHandoffService(db, 'local', new ChannelWakeFanout(),
      { probe, log })
    expect(restored.status(h.control)).toEqual(h.prepared)
    expect(repo.findOpencodeRuntimeByIdentityKey(key, 'local')).toEqual(before)
    expect(service.prepare({ ...h.input, request_id: randomUUID() }))
      .toMatchObject({ error: 'handoff_in_progress' })
    expect(service.prepare({ ...h.input, target_agent_type: 'claude-code' }))
      .toMatchObject({ error: 'request_conflict' })
  })

  it('rejects source changes during asynchronous proof without a partial write', async () => {
    const h = setup()
    let finish!: () => void
    const delayed = new RuntimeHandoffService(db, 'local', new ChannelWakeFanout(),
      { log, probe: () => new Promise(resolve => { finish = () => resolve(undefined) }) })
    const request = delayed.commit({ ...h.control, runtime: runtime('opencode') })
    db.prepare('UPDATE agents SET register_generation=register_generation+1 WHERE agent_id=?')
      .run(h.id)
    finish()
    expect(await request).toMatchObject({ error: 'stale_fence' })
    expect(repo.findById(h.id)?.agent_type).toBe('codex')
    expect(service.status(h.control)).toMatchObject({ state: 'stale' })
    expect(service.abort(h.control)).toMatchObject({ state: 'aborted' })
    expect(service.prepare({ ...h.input, request_id: randomUUID() }))
      .toMatchObject({ state: 'prepared' })
  })

  it('rejects a commit that returns after abort', async () => {
    const h = setup()
    let finish!: () => void
    const delayed = new RuntimeHandoffService(db, 'local', new ChannelWakeFanout(),
      { log, probe: () => new Promise(resolve => { finish = () => resolve(undefined) }) })
    const request = delayed.commit({ ...h.control, runtime: runtime('opencode') })
    expect(service.abort(h.control)).toMatchObject({ state: 'aborted' })
    finish()
    expect(await request).toMatchObject({ error: 'stale_fence' })
    expect(repo.findById(h.id)?.agent_type).toBe('codex')
  })

  it('keeps later registrations from resurrecting old types or old addresses', async () => {
    const h = setup()
    const target = runtime('opencode')
    await service.commit({ ...h.control, runtime: target })
    const legacy = new RegisterAgentService(db, { localDevice: 'local' })
    expect(legacy.register({ connection_id: 'old', name: 'worker', team: 'project',
      agent_type: 'codex', delivery: managedDelivery(h.original) }))
      .toMatchObject({ error: 'agent_id_collision' })
    expect(legacy.register({ connection_id: 'old', name: 'worker', team: 'project',
      agent_type: 'opencode', delivery: managedDelivery(runtime('opencode')) }))
      .toMatchObject({ error: 'agent_id_collision' })
    expect(legacy.register({ connection_id: 'other', name: 'other', team: 'project',
      agent_type: 'opencode', delivery: managedDelivery(target) }))
      .toMatchObject({ error: 'agent_id_collision' })
  })

  it('allocates a fresh OpenCode generation after switching back', async () => {
    const first = setup()
    await service.commit({ ...first.control, runtime: runtime('opencode') })
    const prepare = (source: RuntimeType, target: RuntimeType) => {
      const value = service.prepare({ ...first.input, request_id: randomUUID(),
        source_agent_type: source, target_agent_type: target })
      if (!value.ok) throw new Error(value.error)
      return { ...first.control, fence: value.fence }
    }
    await service.commit({ ...prepare('opencode', 'codex'), runtime: runtime('codex') })
    const next = await service.commit({ ...prepare('codex', 'opencode'),
      runtime: runtime('opencode') })
    expect(next).toMatchObject({ current: { runtime_generation: 3 } })
    expect(service.status(first.control)).toMatchObject({ state: 'stale' })
  })

  it('validates source coordinates, target ownership and strict input schemas', async () => {
    const h = setup()
    expect(prepareHandoffSchema.safeParse({ ...h.input, typo: true }).success)
      .toBe(false)
    expect(service.prepare({ ...h.input, request_id: randomUUID(),
      expected_source: { pane_id: '%123' } })).toMatchObject({ error: 'source_mismatch' })
    expect(service.status({ ...h.control, identity_key: 'wrong-key' }))
      .toMatchObject({ error: 'not_found' })
    const target = runtime('opencode')
    repo.register({ name: 'sibling', device: 'local', agent_type: 'opencode',
      delivery: managedDelivery(target) })
    expect(await service.commit({ ...h.control, runtime: target }))
      .toMatchObject({ error: 'runtime_conflict' })
    expect(repo.findById(h.id)?.agent_type).toBe('codex')
    expect(await service.commit({ ...h.control, runtime: runtime('codex') }))
      .toMatchObject({ error: 'target_mismatch' })
  })

  it('pins the committed Codex endpoint and rejects old proxy rebinding', async () => {
    const h = setup('opencode', 'codex')
    const target = runtime('codex')
    if (target.agent_type !== 'codex') throw new Error('Expected codex')
    await service.commit({ ...h.control, runtime: target })
    const legacy = new RegisterAgentService(db, { localDevice: 'local' })
    expect(legacy.register({ connection_id: 'wrong-endpoint', name: 'worker',
      team: 'project', agent_type: 'codex', delivery: { kind: 'codex-appserver',
        thread_id: target.thread_id, ws_url: 'ws://127.0.0.1:9999/' } }))
      .toMatchObject({ error: 'agent_id_collision' })
    const next = service.prepare({ ...h.input, request_id: randomUUID(),
      source_agent_type: 'codex', target_agent_type: 'claude-code' })
    if (!next.ok) throw new Error(next.error)
    await service.commit({ ...h.control, fence: next.fence,
      runtime: { agent_type: 'claude-code', ui_pid: process.pid } })
    expect(repo.findById(h.id)?.delivery).toEqual({
      kind: 'claude-channel', channel_session_id: 'isolated-channel' })
    repo.register({ name: 'late-proxy', team: 'project', device: 'local',
      role: '__channel_proxy__', claude_ui_pid: process.pid,
      delivery: { kind: 'claude-channel', channel_session_id: 'retired-channel' } })
    expect(repo.findById(h.id)?.delivery).toEqual({
      kind: 'claude-channel', channel_session_id: 'isolated-channel' })
  })

  it('marks an old handoff stale after returning to exactly the same runtime', async () => {
    const h = setup('opencode', 'codex')
    const target = runtime('codex')
    await service.commit({ ...h.control, runtime: target })
    for (const [source, type, coordinates] of [
      ['codex', 'opencode', runtime('opencode')],
      ['opencode', 'codex', target],
    ] as const) {
      const next = service.prepare({ ...h.input, request_id: randomUUID(),
        source_agent_type: source, target_agent_type: type })
      if (!next.ok) throw new Error(next.error)
      await service.commit({ ...h.control, fence: next.fence, runtime: coordinates })
    }
    expect(service.status(h.control)).toMatchObject({ state: 'stale' })
    expect(service.abort(h.control)).toMatchObject({ error: 'already_committed' })
  })

  it('allows controlled same-type fresh replacement without unlocking legacy writes', async () => {
    const h = setup('codex', 'codex')
    const target = runtime('codex')
    expect(await service.commit({ ...h.control, runtime: target }))
      .toMatchObject({ state: 'committed', current: { agent_type: 'codex' } })
    const channels = new ChannelWakeFanout()
    channels.attach('unrelated', () => {}, 'unrelated-session', 'unrelated-proxy')
    expect(new BindChannelService(db, channels).bind({ callerAgentId: h.id,
      channel_session_id: 'unrelated' })).toMatchObject({ error: 'forbidden_role' })
    expect(repo.findById(h.id)?.agent_type).toBe('codex')
  })

  it('rejects an old proxy subscribing to a committed Claude sink', async () => {
    const h = setup('codex', 'claude-code')
    await service.commit({ ...h.control, runtime: runtime('claude-code') })
    const proxy = repo.register({ device: 'local', name: 'old-proxy',
      role: '__channel_proxy__', claude_ui_pid: 123,
      delivery: { kind: 'claude-channel', channel_session_id: 'old-channel' } })
    const channels = new ChannelWakeFanout()
    channels.attach('isolated-channel', () => {}, 'current-session', 'current-proxy')
    expect(new SubscribeChannelWakeService(db, channels).subscribe({
      callerAgentId: proxy.agent_id, channel_session_id: 'isolated-channel',
      sessionId: 'old-session', sink: () => {},
    })).toMatchObject({ error: 'invalid_channel_session_id' })
    expect(channels.owner('isolated-channel')).toBe('current-proxy')
  })

  it('replays a committed Claude handoff after its proxy goes offline', async () => {
    const h = setup('codex', 'claude-code')
    const request = { ...h.control,
      runtime: { agent_type: 'claude-code' as const, ui_pid: process.pid } }
    const committed = await service.commit(request)
    expect(committed).toMatchObject({ state: 'committed' })
    db.prepare("UPDATE agents SET last_seen_at='2000-01-01T00:00:00Z' WHERE role=?")
      .run('__channel_proxy__')
    expect(await service.commit(request)).toEqual(committed)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(await service.commit({ ...request, runtime: { ...request.runtime,
      channel_session_id: 'wrong' } })).toMatchObject({ error: 'runtime_conflict' })
  })

  it('preserves opaque identity bytes and supports a legacy zero registration fence', () => {
    const registered = repo.register({ device: 'local', name: ' worker ',
      team: 'project', identity_key: ' key ', agent_type: 'codex',
      delivery: managedDelivery(runtime('codex')) })
    db.prepare('UPDATE agents SET register_generation=0 WHERE agent_id=?')
      .run(registered.agent_id)
    const input = prepareHandoffSchema.parse({ protocol_version: 1,
      identity_key: ' key ', request_id: randomUUID(), name: ' worker ',
      team: 'project', source_agent_type: 'codex', target_agent_type: 'opencode' })
    expect(input.identity_key).toBe(' key ')
    const prepared = service.prepare(input)
    expect(prepared).toMatchObject({ state: 'prepared',
      source: { agent_id: registered.agent_id, name: ' worker ' },
      fence: { register_generation: 0 } })
  })

  it('verifies exact OpenCode proof over HTTP before changing delivery', async () => {
    const h = setup()
    let returnedId = 'ses_wrong'
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(request.url === '/global/health'
        ? { healthy: true } : { id: returnedId }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const actual = new RuntimeHandoffService(db, 'local',
        new ChannelWakeFanout(), { log })
      const coordinates = { agent_type: 'opencode' as const,
        base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        session_id: 'ses_requested' }
      expect(await actual.commit({ ...h.control, runtime: coordinates }))
        .toMatchObject({ error: 'runtime_probe_failed', retryable: true })
      expect(repo.findById(h.id)?.agent_type).toBe('codex')
      returnedId = coordinates.session_id
      expect(await actual.commit({ ...h.control, runtime: coordinates }))
        .toMatchObject({ state: 'committed' })
      expect(requests).toEqual(['/global/health', '/session/ses_requested',
        '/global/health', '/session/ses_requested'])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  })
})
