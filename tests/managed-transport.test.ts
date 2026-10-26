import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildServer } from '../src/daemon/server.js'
import type { ControlInput, Fence } from '../src/managed/schema.js'

describe('managed REST and MCP ownership', () => {
  let app: Awaited<ReturnType<typeof buildServer>>
  beforeEach(async () => {
    app = await buildServer({ dbPath: ':memory:', localDevice: 'local',
      managedRuntimeProbe: async () => undefined })
  })
  afterEach(async () => { await app.close() })

  const post = (method: string, payload: object) => app.inject({
    method: 'POST', url: `/api/managed/${method}`, payload,
  })
  const prepare = async (name: string) => {
    const input = { protocol_version: 1 as const, identity_key: randomUUID(),
      instance_id: randomUUID(), name, team: 'project', agent_type: 'codex' }
    const res = await post('prepare', input)
    expect(res.statusCode).toBe(200)
    const result = res.json<{ fence: Fence; mcp_token: string }>()
    const control: ControlInput = { protocol_version: 1,
      identity_key: input.identity_key, fence: result.fence }
    return { input, result, control }
  }
  const bind = (control: ControlInput) => post('bind', { ...control, runtime: {
    agent_type: 'codex', thread_id: randomUUID(), ws_url: 'ws://127.0.0.1:8799/',
  } })
  const rpc = (token: string, payload: object, session?: string) => app.inject({
    method: 'POST', url: '/mcp', headers: {
      accept: 'application/json, text/event-stream',
      'x-xats-managed-token': token,
      ...(session ? { 'mcp-session-id': session } : {}),
    }, payload,
  })
  const initialize = async (token: string) => {
    const res = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'managed-test', version: '1' } } })
    expect(res.statusCode).toBe(200)
    const session = String(res.headers['mcp-session-id'])
    await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)
    return session
  }

  it('attaches an initialized connection when bind arrives later', async () => {
    const { control, result } = await prepare('first')
    await initialize(result.mcp_token)
    expect((await post('status', control)).json()).toMatchObject({
      state: 'prepared', runtime: null, agent_id: null,
    })
    expect((await bind(control)).statusCode).toBe(200)
    expect((await post('status', control)).json()).toMatchObject({ state: 'ready' })
  })

  it('rejects switching tokens on an existing MCP connection', async () => {
    const a = await prepare('a')
    const b = await prepare('b')
    await bind(a.control)
    await bind(b.control)
    const session = await initialize(a.result.mcp_token)
    const switched = await rpc(b.result.mcp_token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_inbox', arguments: {} },
    }, session)
    expect(switched.statusCode).toBe(403)
    expect((await post('status', a.control)).json()).toMatchObject({ state: 'ready' })
    expect((await post('status', b.control)).json()).toMatchObject({ state: 'bound' })
  })

  it('rejects old tokens and old release after a restart', async () => {
    const { input, control, result } = await prepare('first')
    await bind(control)
    const session = await initialize(result.mcp_token)
    const restarted = await post('prepare', { ...input,
      instance_id: randomUUID(), previous: result.fence })
    expect(restarted.statusCode).toBe(200)
    expect((await post('release', control)).statusCode).toBe(409)
    const stale = await rpc(result.mcp_token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_inbox', arguments: {} },
    }, session)
    expect(stale.statusCode).toBe(403)
  })

  it('rejects control-plane mutation from a managed business connection', async () => {
    const { control, result } = await prepare('first')
    await bind(control)
    const session = await initialize(result.mcp_token)
    const rejected = await rpc(result.mcp_token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'unregister_self', arguments: {} },
    }, session)
    expect(rejected.statusCode).toBe(403)
    expect((await post('status', control)).json()).toMatchObject({ state: 'ready' })
  })

  it('returns protocol errors for invalid runtime URLs and unknown fields', async () => {
    const { control } = await prepare('first')
    const invalid = await post('bind', { ...control, runtime: {
      agent_type: 'codex', thread_id: randomUUID(), ws_url: 'not-a-url',
    } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ ok: false, error: 'invalid_request' })
    expect((await post('status', { ...control, extra: true })).statusCode).toBe(400)
    const malformed = await app.inject({ method: 'POST',
      url: '/api/managed/prepare', headers: { 'content-type': 'application/json' },
      payload: '{broken' })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ ok: false, error: 'invalid_request' })
  })
})
