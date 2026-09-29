import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/daemon/server.js'
import { CodexBindingLookup } from '../src/mcp/codex-binding-lookup.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  execFileSync: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  spawn: vi.fn(() => { throw new Error('Unexpected subprocess') }),
}))

describe('Codex binding lookup HTTP contract', () => {
  let app: Awaited<ReturnType<typeof buildServer>>
  const input = {
    protocol_version: 1,
    pane_id: '%22',
    launch_id: '11111111-1111-4111-8111-111111111111',
  }

  beforeEach(async () => {
    app = await buildServer({ dbPath: ':memory:', localDevice: 'local' })
  })

  afterEach(async () => { await app.close(); vi.restoreAllMocks() })

  it('returns not_found instead of inventing a thread for an unknown launch',
    async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/codex/binding/lookup',
        payload: input,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: false, error: 'not_found' })
    })

  it.each([
    { ...input, protocol_version: 2 },
    { ...input, pane_id: '%22;bad' },
    { ...input, launch_id: 'not-a-uuid' },
    { ...input, thread_id: 'injected' },
    { pane_id: '%22', launch_id: input.launch_id },
  ])('rejects invalid input without echoing it: %j', async payload => {
    const lookup = vi.spyOn(CodexBindingLookup.prototype, 'lookup')
    const response = await app.inject({
      method: 'POST', url: '/api/codex/binding/lookup', payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      ok: false, error: 'invalid_request', detail: 'Invalid Codex binding lookup',
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/codex/binding/lookup',
      headers: { 'content-type': 'application/json' }, payload: '{',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ ok: false, error: 'invalid_request' })
  })

  it('preserves the successful v1 envelope', async () => {
    vi.spyOn(CodexBindingLookup.prototype, 'lookup').mockResolvedValue({
      ok: true, ...input, protocol_version: 1,
      thread_id: '33333333-3333-4333-8333-333333333333',
    })
    const response = await app.inject({
      method: 'POST', url: '/api/codex/binding/lookup', payload: input,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true, ...input, thread_id: '33333333-3333-4333-8333-333333333333',
    })
  })

  it.each(['pending', 'stale', 'ambiguous'] as const)(
    'preserves domain refusal %s without a thread', async error => {
      vi.spyOn(CodexBindingLookup.prototype, 'lookup').mockResolvedValue({
        ok: false, error,
      })
      const response = await app.inject({
        method: 'POST', url: '/api/codex/binding/lookup', payload: input,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: false, error })
    })

  it.each([
    { error: { code: 'SQLITE_BUSY' }, status: 503, message: 'storage_unavailable' },
    {
      error: new Error('private probe detail'), status: 500, message: 'internal_error',
    },
  ])('sanitizes failures: $message', async ({ error, status, message }) => {
    vi.spyOn(CodexBindingLookup.prototype, 'lookup').mockRejectedValue(error)
    const response = await app.inject({
      method: 'POST', url: '/api/codex/binding/lookup', payload: input,
    })
    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual({ ok: false, error: message })
  })

  it('rejects non-loopback access before lookup', async () => {
    const lookup = vi.spyOn(CodexBindingLookup.prototype, 'lookup')
    const response = await app.inject({
      method: 'POST', url: '/api/codex/binding/lookup', payload: input,
      remoteAddress: '203.0.113.1',
    })
    expect(response.statusCode).toBe(403)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('requires configured bearer authentication', async () => {
    await app.close()
    app = await buildServer({ dbPath: ':memory:', token: 'test-only' })
    const response = await app.inject({
      method: 'POST', url: '/api/codex/binding/lookup', payload: input,
    })
    expect(response.statusCode).toBe(401)
  })
})
