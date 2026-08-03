import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { RegisterOpencodeSelfService } from '../src/mcp/register-opencode-self.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-register-opencode-self-'))

const BASE_URL = 'http://127.0.0.1:18888'

type RouteHandler = (url: string, init?: RequestInit) => {
  status?: number
  body?: string
} | null

function makeFetch(handlers: RouteHandler[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    for (const handler of handlers) {
      const result = handler(url, init)
      if (result !== null) {
        const status = result.status ?? 200
        const body = result.body ?? ''
        return new Response(body.length > 0 ? body : null, { status })
      }
    }
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
}

const healthHandler: RouteHandler = (url) =>
  url.endsWith('/global/health') ? { status: 200, body: '{"healthy":true}' } : null

function sessionListHandler(ids: string[]): RouteHandler {
  return (url) =>
    url.endsWith('/session')
      ? {
          status: 200,
          body: JSON.stringify(
            ids.map((id, i) => ({ id, time_updated: 1000 + i }))
          ),
        }
      : null
}

describe('RegisterOpencodeSelfService', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function setup(
    fetchMock: typeof fetch,
    env?: NodeJS.ProcessEnv,
    requestTimeoutMs?: number
  ) {
    const dir = tmp()
    cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const registerSvc = new RegisterAgentService(db)
    const svc = new RegisterOpencodeSelfService(registerSvc, {
      fetch: fetchMock,
      env,
      requestTimeoutMs,
    })
    return { db, svc }
  }

  it('writes opencode-server delivery when session_id is explicit', async () => {
    const fetchMock = makeFetch([healthHandler, sessionListHandler(['ses_xyz'])])
    const { db, svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
      session_id: 'ses_xyz',
    })

    expect(result).toEqual({
      agent_id: expect.any(String),
      team: 'default',
      session_id: 'ses_xyz',
      base_url: BASE_URL,
    })
    const row = db.prepare(
      'SELECT delivery_kind, delivery_payload, tmux_pane_id, model FROM agents WHERE team=? AND name=?'
    ).get('default', 'oc-1') as {
      delivery_kind: string
      delivery_payload: string | null
      tmux_pane_id: string | null
      model: string | null
    }
    expect(row.delivery_kind).toBe('opencode-server')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      session_id: 'ses_xyz',
      base_url: BASE_URL,
    })
    expect(row.tmux_pane_id).toBeNull()
    expect(row.model).toBeNull()
  })

  it('atomically stores initial fence and delivery generation', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) => url.endsWith('/session/ses_runtime')
        ? { status: 200, body: '{"id":"ses_runtime"}' }
        : null,
    ])
    const { db, svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-runtime',
      name: 'oc-runtime',
      base_url: `${BASE_URL}/`,
      session_id: 'ses_runtime',
      identity_key: 'runtime-key',
      runtime_generation: 8,
    })

    expect(result).toMatchObject({
      session_id: 'ses_runtime',
      base_url: BASE_URL,
    })
    const row = db.prepare(
      `SELECT opencode_runtime_generation, delivery_payload
       FROM agents WHERE identity_key = 'runtime-key'`
    ).get() as {
      opencode_runtime_generation: number
      delivery_payload: string
    }
    expect(row.opencode_runtime_generation).toBe(8)
    expect(JSON.parse(row.delivery_payload)).toMatchObject({
      session_id: 'ses_runtime',
      base_url: BASE_URL,
      runtime_generation: 8,
    })
  })

  it('allows generation-bearing register only for fresh initialization', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) => url.includes('/session/ses_')
        ? { status: 200, body: JSON.stringify({ id: url.split('/').at(-1) }) }
        : null,
    ])
    const cases = [
      {
        generation: 1,
        session_id: 'ses_lower',
        error: 'stale_runtime_generation',
      },
      {
        generation: 3,
        session_id: 'ses_higher',
        error: 'runtime_generation_not_reserved',
      },
      {
        generation: 2,
        session_id: 'ses_conflict',
        error: 'runtime_generation_conflict',
      },
    ] as const

    for (const item of cases) {
      const { db, svc } = setup(fetchMock)
      expect(await svc.register({
        connection_id: `conn-initial-${item.error}`,
        name: `oc-${item.error}`,
        base_url: BASE_URL,
        session_id: 'ses_current',
        identity_key: `key-${item.error}`,
        runtime_generation: 2,
      })).toMatchObject({ agent_id: expect.any(String) })

      expect(await svc.register({
        connection_id: `conn-retry-${item.error}`,
        name: `oc-${item.error}`,
        base_url: BASE_URL,
        session_id: item.session_id,
        identity_key: `key-${item.error}`,
        runtime_generation: item.generation,
      })).toMatchObject({ error: item.error })

      const row = db.prepare(
        `SELECT opencode_runtime_generation, delivery_payload
         FROM agents WHERE identity_key = ?`
      ).get(`key-${item.error}`) as {
        opencode_runtime_generation: number
        delivery_payload: string
      }
      expect(row.opencode_runtime_generation).toBe(2)
      expect(JSON.parse(row.delivery_payload)).toMatchObject({
        session_id: 'ses_current',
        runtime_generation: 2,
      })
      db.close()
    }
  })

  it('keeps an exact generation-bearing register idempotent', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) => url.endsWith('/session/ses_same')
        ? { status: 200, body: '{"id":"ses_same"}' }
        : null,
    ])
    const { db, svc } = setup(fetchMock)
    const input = {
      name: 'oc-same',
      base_url: BASE_URL,
      session_id: 'ses_same',
      identity_key: 'same-key',
      runtime_generation: 2,
    }
    const first = await svc.register({ connection_id: 'conn-1', ...input })
    const second = await svc.register({ connection_id: 'conn-2', ...input })
    expect(second).toMatchObject({
      agent_id: (first as { agent_id: string }).agent_id,
    })
    const row = db.prepare(
      `SELECT opencode_runtime_generation, register_generation
       FROM agents WHERE identity_key = 'same-key'`
    ).get() as {
      opencode_runtime_generation: number
      register_generation: number
    }
    expect(row).toEqual({
      opencode_runtime_generation: 2,
      register_generation: 1,
    })
  })

  it('rejects a canonical delivery pair already owned by another row', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) => url.endsWith('/session/ses_shared')
        ? { status: 200, body: '{"id":"ses_shared"}' }
        : null,
    ])
    const { db, svc } = setup(fetchMock)
    expect(await svc.register({
      connection_id: 'conn-owner',
      name: 'owner',
      base_url: 'http://LOCALHOST:80/',
      session_id: 'ses_shared',
      identity_key: 'owner-key',
      runtime_generation: 1,
    })).toMatchObject({ agent_id: expect.any(String) })
    expect(await svc.register({
      connection_id: 'conn-other',
      name: 'other',
      base_url: 'http://localhost',
      session_id: 'ses_shared',
      identity_key: 'other-key',
      runtime_generation: 1,
    })).toMatchObject({ error: 'runtime_delivery_conflict' })
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM agents WHERE delivery_kind = 'opencode-server'`
    ).get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('bounds a never-resolving exact session probe without registering', async () => {
    const fetchMock = (async (input: string) => {
      if (input.endsWith('/global/health')) {
        return new Response('{"healthy":true}', { status: 200 })
      }
      return new Promise<Response>(() => {})
    }) as typeof fetch
    const { db, svc } = setup(fetchMock, undefined, 10)

    expect(await svc.register({
      connection_id: 'conn-timeout',
      name: 'oc-timeout',
      base_url: BASE_URL,
      session_id: 'ses_timeout',
      identity_key: 'timeout-key',
      runtime_generation: 1,
    })).toMatchObject({ error: 'opencode_unreachable' })
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM agents WHERE identity_key = 'timeout-key'`
    ).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('auto-resolves session_id by max time_updated when session_id omitted', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) =>
        url.endsWith('/session')
          ? {
              status: 200,
              body: JSON.stringify([
                { id: 'ses_a', time_updated: 1000 },
                { id: 'ses_b', time_updated: 2000 },
                { id: 'ses_c', time_updated: 1500 },
              ]),
            }
          : null,
    ])
    const { db, svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
    })

    expect(result).toMatchObject({ session_id: 'ses_b' })
    const row = db.prepare(
      'SELECT delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'oc-1') as { delivery_payload: string }
    expect(JSON.parse(row.delivery_payload).session_id).toBe('ses_b')
  })

  it('auto-resolves session_id from nested time.updated (opencode 1.17.x format)', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) =>
        url.endsWith('/session')
          ? {
              status: 200,
              body: JSON.stringify([
                { id: 'ses_a', time: { created: 1000, updated: 1000 } },
                { id: 'ses_b', time: { created: 1900, updated: 2000 } },
                { id: 'ses_c', time: { created: 1400, updated: 1500 } },
              ]),
            }
          : null,
    ])
    const { db, svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
    })

    expect(result).toMatchObject({ session_id: 'ses_b' })
    const row = db.prepare(
      'SELECT delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'oc-1') as { delivery_payload: string }
    expect(JSON.parse(row.delivery_payload).session_id).toBe('ses_b')
  })

  it('prefers flat time_updated over nested time.updated when both present', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) =>
        url.endsWith('/session')
          ? {
              status: 200,
              body: JSON.stringify([
                { id: 'ses_flat', time_updated: 3000, time: { updated: 999 } },
                { id: 'ses_nested', time_updated: 500, time: { updated: 9000 } },
              ]),
            }
          : null,
    ])
    const { svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
    })

    expect(result).toMatchObject({ session_id: 'ses_flat' })
  })

  it('returns no_active_session when session list is empty', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) => (url.endsWith('/session') ? { status: 200, body: '[]' } : null),
    ])
    const { db, svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
    })

    expect(result).toEqual({
      error: 'no_active_session',
      detail: { base_url: BASE_URL },
    })
    const row = db.prepare('SELECT agent_id FROM agents WHERE name=?').get('oc-1')
    expect(row).toBeUndefined()
  })

  it('returns opencode_unreachable when health check fails (connection refused)', async () => {
    const fetchMock = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const { db, svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: 'http://127.0.0.1:9999',
    })

    expect(result).toEqual({
      error: 'opencode_unreachable',
      detail: { base_url: 'http://127.0.0.1:9999', cause: 'ECONNREFUSED' },
    })
    const row = db.prepare('SELECT agent_id FROM agents WHERE name=?').get('oc-1')
    expect(row).toBeUndefined()
  })

  it('returns opencode_unreachable when health check returns non-2xx', async () => {
    const fetchMock = makeFetch([
      (url) => (url.endsWith('/global/health') ? { status: 503, body: 'down' } : null),
    ])
    const { svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
    })

    expect((result as { error: string }).error).toBe('opencode_unreachable')
    expect((result as { detail: { cause: string } }).detail.cause).toMatch(/503/)
  })

  it('does NOT issue /session request when health check fails', async () => {
    let sessionHit = false
    const fetchMock = makeFetch([
      (url) => {
        if (url.endsWith('/global/health')) return { status: 503 }
        if (url.endsWith('/session')) {
          sessionHit = true
          return { status: 200, body: '[]' }
        }
        return null
      },
    ])
    const { svc } = setup(fetchMock)

    await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
    })
    expect(sessionHit).toBe(false)
  })

  it('preserves auth_token_ref in delivery when supplied', async () => {
    const fetchMock = makeFetch([healthHandler, sessionListHandler(['ses_abc'])])
    const { db, svc } = setup(fetchMock, { OPENCODE_SERVER_PASSWORD: 'secret' })

    await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
      session_id: 'ses_abc',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })

    const row = db.prepare(
      'SELECT delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'oc-1') as { delivery_payload: string }
    expect(JSON.parse(row.delivery_payload)).toEqual({
      session_id: 'ses_abc',
      base_url: BASE_URL,
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })
  })

  it('persists explicit model when supplied', async () => {
    const fetchMock = makeFetch([healthHandler, sessionListHandler(['ses_abc'])])
    const { db, svc } = setup(fetchMock)

    await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
      session_id: 'ses_abc',
      model: 'glm-5.2',
    })

    const row = db.prepare(
      'SELECT model FROM agents WHERE team=? AND name=?'
    ).get('default', 'oc-1') as { model: string | null }
    expect(row.model).toBe('glm-5.2')
  })

  it('strips trailing slashes from base_url when building URLs', async () => {
    const seenUrls: string[] = []
    const fetchMock = makeFetch([
      (url) => {
        seenUrls.push(url)
        if (url.endsWith('/global/health')) return { status: 200, body: '{"healthy":true}' }
        if (url.endsWith('/session')) {
          return { status: 200, body: JSON.stringify([{ id: 'ses_abc', time_updated: 1000 }]) }
        }
        return null
      },
    ])
    const { svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: `${BASE_URL}//`,
      session_id: 'ses_abc',
    })

    expect(result).toMatchObject({ agent_id: expect.any(String) })
    expect(seenUrls).toContain(`${BASE_URL}/global/health`)
  })

  it('returns envelope session_id matching caller-supplied value', async () => {
    const fetchMock = makeFetch([healthHandler, sessionListHandler(['ses_explicit'])])
    const { svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
      session_id: 'ses_explicit',
    })

    expect((result as { session_id: string }).session_id).toBe('ses_explicit')
    expect((result as { base_url: string }).base_url).toBe(BASE_URL)
  })

  it('returns session_not_found when explicit session_id is absent from the live list', async () => {
    const fetchMock = makeFetch([healthHandler, sessionListHandler(['ses_other'])])
    const { db, svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
      session_id: 'ses_stale',
    })

    expect(result).toEqual({
      error: 'session_not_found',
      detail: { base_url: BASE_URL, session_id: 'ses_stale' },
    })
    const row = db.prepare('SELECT agent_id FROM agents WHERE name=?').get('oc-1')
    expect(row).toBeUndefined()
  })

  it('validates only the exact session endpoint for runtime recovery', async () => {
    const seenUrls: string[] = []
    const fetchMock = makeFetch([
      healthHandler,
      (url) => {
        seenUrls.push(url)
        return url.endsWith('/session/ses_exact')
          ? { status: 200, body: '{"id":"ses_exact"}' }
          : null
      },
    ])
    const { svc } = setup(fetchMock)

    expect(await svc.validateExactSession(
      BASE_URL,
      'ses_exact'
    )).toEqual({ ok: true })
    expect(seenUrls).toContain(`${BASE_URL}/session/ses_exact`)
    expect(seenUrls).not.toContain(`${BASE_URL}/session`)
  })

  it('rejects a mismatched exact session response', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) => url.endsWith('/session/ses_exact')
        ? { status: 200, body: '{"id":"ses_other"}' }
        : null,
    ])
    const { svc } = setup(fetchMock)

    expect(await svc.validateExactSession(
      BASE_URL,
      'ses_exact'
    )).toEqual({
      error: 'session_not_found',
      detail: { base_url: BASE_URL, session_id: 'ses_exact' },
    })
  })

  it('returns missing_auth_token when auth_token_ref points at an unset env var', async () => {
    const fetchMock = makeFetch([healthHandler, sessionListHandler(['ses_abc'])])
    const { db, svc } = setup(fetchMock, {})

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
      session_id: 'ses_abc',
      auth_token_ref: 'MISSING_TOKEN',
    })

    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'MISSING_TOKEN' },
    })
    const row = db.prepare('SELECT agent_id FROM agents WHERE name=?').get('oc-1')
    expect(row).toBeUndefined()
  })

  it('sends Authorization header on health and session when auth_token_ref resolves', async () => {
    const seenHeaders: Record<string, string>[] = []
    const fetchMock = makeFetch([
      (url, init) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>)
        if (url.endsWith('/global/health')) return { status: 200, body: '{"healthy":true}' }
        if (url.endsWith('/session')) {
          return { status: 200, body: JSON.stringify([{ id: 'ses_abc', time_updated: 1000 }]) }
        }
        return null
      },
    ])
    const { svc } = setup(fetchMock, { OPENCODE_SERVER_PASSWORD: 'tok123' })

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
      session_id: 'ses_abc',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })

    expect(result).toMatchObject({ agent_id: expect.any(String) })
    expect(seenHeaders.length).toBeGreaterThanOrEqual(2)
    const expected = `Basic ${Buffer.from('opencode:tok123').toString('base64')}`
    for (const h of seenHeaders) {
      expect(h['Authorization']).toBe(expected)
    }
  })

  it('returns opencode_unreachable (not no_active_session) when /session is non-2xx', async () => {
    const fetchMock = makeFetch([
      healthHandler,
      (url) => (url.endsWith('/session') ? { status: 500, body: 'boom' } : null),
    ])
    const { svc } = setup(fetchMock)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'oc-1',
      base_url: BASE_URL,
    })

    expect((result as { error: string }).error).toBe('opencode_unreachable')
    expect((result as { detail: { cause: string } }).detail.cause).toMatch(/500/)
  })
})
