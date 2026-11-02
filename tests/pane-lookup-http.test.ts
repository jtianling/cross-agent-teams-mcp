import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildServer } from '../src/daemon/server.js'

describe('pane lookup request boundaries without host probes', () => {
  let app: Awaited<ReturnType<typeof buildServer>>
  const url = '/api/runtime/pane/lookup'
  const payload = { protocol_version: 1, tmux: {
    socket_path: '/test/socket', server_pid: 1,
    server_started_at: 1793000000, pane_id: '%0',
  } }
  beforeEach(async () => { app = await buildServer({ dbPath: ':memory:' }) })
  afterEach(async () => { await app.close() })

  it('rejects a remote request with the frozen error envelope', async () => {
    const result = await app.inject({ method: 'POST', url, payload,
      remoteAddress: '192.0.2.1' })
    expect(result.statusCode).toBe(403)
    expect(result.json()).toEqual({ ok: false, error: 'remote_forbidden',
      detail: 'Pane lookup requires loopback' })
  })

  it('rejects an unknown managed key field through the read-only schema', async () => {
    const key = randomUUID()
    const prepared = await app.inject({ method: 'POST',
      url: '/api/managed/prepare', payload: { protocol_version: 1,
        identity_key: key, instance_id: randomUUID(), name: 'worker',
        team: 'test', agent_type: 'codex' } })
    expect(prepared.statusCode).toBe(200)
    const result = await app.inject({ method: 'POST', url,
      payload: { ...payload, identity_key: key } })
    expect(result.statusCode).toBe(400)
    expect(result.json()).toEqual({ ok: false, error: 'invalid_request',
      detail: 'Request does not match pane lookup protocol v1 schema' })
    const legacy = await app.inject({ method: 'POST',
      url: '/api/runtime/opencode/reserve', payload: { protocol_version: 1,
        identity_key: key, runtime_generation: 1 } })
    expect(legacy.statusCode).toBe(409)
  })

  it('returns the protocol envelope for invalid JSON', async () => {
    const result = await app.inject({ method: 'POST', url, payload: '{broken',
      headers: { 'content-type': 'application/json' } })
    expect(result.statusCode).toBe(400)
    expect(result.json()).toMatchObject({ ok: false, error: 'invalid_request' })
  })
})
