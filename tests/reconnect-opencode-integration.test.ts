import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

// This file does NOT mock register-opencode-self.js — it exercises the real
// RegisterOpencodeSelfService against a stubbed global fetch, so the credential
// recovery order and Basic-auth wire format are covered end-to-end.

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-reconnect-opencode-integ-'))
const BASE_URL = 'http://127.0.0.1:18888'

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

interface SeenCall { url: string; headers: Record<string, string> }

function makeAuthedServerFetch(seen: SeenCall[], sessions: Array<{ id: string; time_updated: number }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    if (url.endsWith('/global/health')) {
      return new Response('{"healthy":true}', { status: 200 })
    }
    if (url.endsWith('/session')) {
      return new Response(JSON.stringify(sessions), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
}

// Strict authenticated server: health/session return 401 unless the Basic
// header matches the expected credentials.
function makeStrictAuthFetch(
  seen: SeenCall[],
  sessions: Array<{ id: string; time_updated: number }>,
  password: string,
  username = 'opencode'
): typeof fetch {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  return (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push({ url, headers })
    if (url.endsWith('/global/health') || url.endsWith('/session')) {
      if (headers['Authorization'] !== expected) {
        return new Response('unauthorized', { status: 401 })
      }
      if (url.endsWith('/global/health')) {
        return new Response('{"healthy":true}', { status: 200 })
      }
      return new Response(JSON.stringify(sessions), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
}

function seedOpencode(
  db: ReturnType<typeof openDb>,
  args: {
    agent_id: string
    session_id: string
    name: string
    auth_token_ref?: string
  }
): void {
  db.prepare(
    `INSERT INTO agents (
       agent_id, agent_type, device, team, role, name, registered_at, last_seen_at,
       delivery_kind, delivery_payload, last_processed_event_id
     ) VALUES (?, 'opencode', 'local', 'default', 'worker', ?, ?, ?,
       'opencode-server', ?, 0)`
  ).run(
    args.agent_id,
    args.name,
    '2024-01-01T00:00:00.000Z',
    '2024-01-02T00:00:00.000Z',
    JSON.stringify({
      session_id: args.session_id,
      base_url: BASE_URL,
      ...(args.auth_token_ref === undefined ? {} : { auth_token_ref: args.auth_token_ref }),
    })
  )
}

describe('reconnect opencode: credential recovery + Basic auth (integration)', () => {
  const cleanups: string[] = []
  const envKeys: string[] = []

  afterEach(() => {
    for (const k of envKeys) delete process.env[k]
    envKeys.length = 0
    vi.unstubAllGlobals()
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  async function setup() {
    const dir = tmp()
    cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db, { localDevice: 'local' })
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    const holder: { current: string | undefined } = { current: undefined }
    const sessionId = 'session-integ'
    registerBusinessTools(
      server,
      db,
      () => holder.current ?? sessionId,
      undefined,
      (agentId: string) => { holder.current = agentId },
      () => sessionId,
      undefined,
      undefined,
      undefined,
      undefined,
      { localDevice: 'local' },
    )
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'opencode', version: '0.0.0' })
    await client.connect(ct)
    return { dir, db, server, client, transport: ct, holder }
  }

  it('recovers stored auth_token_ref so an authenticated server revalidates when caller omits the ref', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'integ-pw'
    envKeys.push('OPENCODE_SERVER_PASSWORD')
    const seen: SeenCall[] = []
    vi.stubGlobal('fetch', makeAuthedServerFetch(seen, [
      { id: 'ses_keep', time_updated: 1000 },
    ]))

    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencode(db, {
      agent_id: 'O',
      session_id: 'ses_keep',
      name: 'xats-opencode',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })

    // Caller omits auth_token_ref — recoverOpencodeAuth must read the stored
    // ref from the DB row before resolveSessionId talks to the server.
    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL, session_id: 'ses_keep' },
    })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    expect(obj.agent_id).toBe('O')

    // Both the health and the session-list probes must carry the Basic header
    // built from the recovered ref — proving the credential was used for the
    // server round-trip, not just persisted afterwards.
    const authHeaders = seen
      .filter(c => c.url.endsWith('/global/health') || c.url.endsWith('/session'))
      .map(c => c.headers['Authorization'])
    expect(authHeaders.length).toBeGreaterThanOrEqual(2)
    const expected = `Basic ${Buffer.from('opencode:integ-pw').toString('base64')}`
    for (const h of authHeaders) expect(h).toBe(expected)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('preserves a committed runtime generation on legacy reconnect', async () => {
    const seen: SeenCall[] = []
    vi.stubGlobal('fetch', makeAuthedServerFetch(seen, [
      { id: 'ses_runtime', time_updated: 1000 },
    ]))
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const registered = new AgentsRepo(db).register({
      agent_type: 'opencode',
      name: 'runtime-aware',
      team: 'default',
      role: 'worker',
      identity_key: 'runtime-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: BASE_URL,
        session_id: 'ses_runtime',
        runtime_generation: 2,
      },
    })
    const before = db.prepare(
      `SELECT register_generation, delivery_payload
       FROM agents WHERE agent_id = ?`
    ).get(registered.agent_id) as {
      register_generation: number
      delivery_payload: string
    }

    const response = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL, session_id: 'ses_runtime' },
    })
    expect(await parseTool(response)).toMatchObject({
      ok: true,
      agent_id: registered.agent_id,
      connection_bound: true,
      runtime_generation: 2,
    })
    const after = db.prepare(
      `SELECT register_generation, opencode_runtime_generation,
              delivery_payload
       FROM agents WHERE agent_id = ?`
    ).get(registered.agent_id) as {
      register_generation: number
      opencode_runtime_generation: number
      delivery_payload: string
    }
    expect(after).toEqual({
      register_generation: before.register_generation,
      opencode_runtime_generation: 2,
      delivery_payload: before.delivery_payload,
    })

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('accepts an effective-type legacy runtime with agent_type null', async () => {
    const seen: SeenCall[] = []
    vi.stubGlobal('fetch', makeAuthedServerFetch(seen, [
      { id: 'ses_effective', time_updated: 1000 },
    ]))
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const registered = new AgentsRepo(db).register({
      agent_type: 'opencode',
      name: 'effective-runtime',
      team: 'default',
      role: 'worker',
      identity_key: 'effective-runtime-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: BASE_URL,
        session_id: 'ses_effective',
        runtime_generation: 2,
      },
    })
    db.prepare(
      `UPDATE agents SET agent_type = NULL WHERE agent_id = ?`
    ).run(registered.agent_id)
    const before = db.prepare(
      `SELECT agent_type, register_generation,
              opencode_runtime_generation, delivery_payload
       FROM agents WHERE agent_id = ?`
    ).get(registered.agent_id)

    const response = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL, session_id: 'ses_effective' },
    })
    expect(await parseTool(response)).toMatchObject({
      ok: true,
      agent_id: registered.agent_id,
      connection_bound: true,
      runtime_generation: 2,
    })
    const after = db.prepare(
      `SELECT agent_type, register_generation,
              opencode_runtime_generation, delivery_payload
       FROM agents WHERE agent_id = ?`
    ).get(registered.agent_id)
    expect(after).toEqual(before)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('fails closed when registration changes during legacy probe', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const registered = new AgentsRepo(db).register({
      agent_type: 'opencode',
      name: 'runtime-race',
      team: 'default',
      role: 'worker',
      identity_key: 'runtime-race-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: BASE_URL,
        session_id: 'ses_runtime_race',
        runtime_generation: 2,
      },
    })
    let changed = false
    vi.stubGlobal('fetch', (async (url: string) => {
      if (url.endsWith('/global/health')) {
        return new Response('{"healthy":true}', { status: 200 })
      }
      if (url.endsWith('/session')) {
        db.prepare(
          `UPDATE agents
           SET register_generation = register_generation + 1
           WHERE agent_id = ?`
        ).run(registered.agent_id)
        changed = true
        return new Response(JSON.stringify([
          { id: 'ses_runtime_race', time_updated: 1000 },
        ]), { status: 200 })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch)

    expect(await parseTool(await client.callTool({
      name: 'reconnect',
      arguments: {
        base_url: BASE_URL,
        session_id: 'ses_runtime_race',
      },
    }))).toEqual({ error: 'opencode_runtime_coordinates_required' })
    expect(changed).toBe(true)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('honors OPENCODE_SERVER_USERNAME when recovering Basic credentials', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'pw'
    process.env.OPENCODE_SERVER_USERNAME = 'bot'
    envKeys.push('OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME')
    const seen: SeenCall[] = []
    vi.stubGlobal('fetch', makeAuthedServerFetch(seen, [
      { id: 'ses_keep', time_updated: 1000 },
    ]))

    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencode(db, {
      agent_id: 'O',
      session_id: 'ses_keep',
      name: 'xats-opencode',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL, session_id: 'ses_keep' },
    })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    const expected = `Basic ${Buffer.from('bot:pw').toString('base64')}`
    const healthHeader = seen.find(c => c.url.endsWith('/global/health'))?.headers['Authorization']
    expect(healthHeader).toBe(expected)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('recovers stored auth on the base_url-only path via an unambiguous single row', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'pw'
    envKeys.push('OPENCODE_SERVER_PASSWORD')
    const seen: SeenCall[] = []
    vi.stubGlobal('fetch', makeAuthedServerFetch(seen, [
      { id: 'ses_recent', time_updated: 2000 },
    ]))

    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencode(db, {
      agent_id: 'O',
      session_id: 'ses_recent',
      name: 'xats-opencode',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })

    // Neither session_id nor auth_token_ref supplied: the broad base_url probe
    // must recover the single stored ref before the server round-trip.
    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL },
    })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    expect(obj.session_id).toBe('ses_recent')
    const expected = `Basic ${Buffer.from('opencode:pw').toString('base64')}`
    const sessionHeader = seen.find(c => c.url.endsWith('/session'))?.headers['Authorization']
    expect(sessionHeader).toBe(expected)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns auth_ambiguous without any HTTP round-trip when candidates mix ref and no-ref rows', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'pw'
    envKeys.push('OPENCODE_SERVER_PASSWORD')
    const seen: SeenCall[] = []
    vi.stubGlobal('fetch', makeStrictAuthFetch(
      seen,
      [{ id: 'ses_mix', time_updated: 1000 }],
      'pw',
    ))

    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencode(db, {
      agent_id: 'A', session_id: 'ses_mix', name: 'oc-a',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })
    seedOpencode(db, {
      agent_id: 'B', session_id: 'ses_mix', name: 'oc-b',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL, session_id: 'ses_mix' },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'auth_ambiguous',
      detail: { refs: ['OPENCODE_SERVER_PASSWORD'] },
    })
    // Mixed auth state short-circuits before any server probe.
    expect(seen).toHaveLength(0)
    const rows = db.prepare(
      `SELECT agent_id, last_seen_at FROM agents ORDER BY agent_id`
    ).all() as Array<{ agent_id: string; last_seen_at: string }>
    expect(rows).toEqual([
      { agent_id: 'A', last_seen_at: '2024-01-02T00:00:00.000Z' },
      { agent_id: 'B', last_seen_at: '2024-01-02T00:00:00.000Z' },
    ])

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('reaches ambiguous (not unreachable) when multiple candidates share one ref on an authenticated server', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'shared-pw'
    envKeys.push('OPENCODE_SERVER_PASSWORD')
    const seen: SeenCall[] = []
    vi.stubGlobal('fetch', makeStrictAuthFetch(
      seen,
      [{ id: 'ses_shared', time_updated: 1000 }],
      'shared-pw',
    ))

    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencode(db, {
      agent_id: 'A', session_id: 'ses_shared', name: 'oc-a',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })
    seedOpencode(db, {
      agent_id: 'B', session_id: 'ses_shared', name: 'oc-b',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL, session_id: 'ses_shared' },
    })
    const obj = await parseTool(resp)

    // The shared ref pre-validates the authenticated server, then the precise
    // resolver surfaces the two identity rows as ambiguous (zero write) —
    // never an opencode_unreachable from a missing-auth 401.
    expect(obj.ambiguous).toBe(true)
    const candidates = obj.candidates as Array<{ name: string }>
    expect(candidates.map(c => c.name).sort()).toEqual(['oc-a', 'oc-b'])
    expect(seen.find(c => c.url.endsWith('/global/health'))?.headers['Authorization']).toMatch(/^Basic /)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('fails revalidation when the caller omits the ref and no stored ref exists (401 surfaces)', async () => {
    // Authenticated server that rejects any request without a valid Basic header.
    const seen: SeenCall[] = []
    const fetchMock = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response('unauthorized', { status: 401 })
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    // No stored auth_token_ref on the row.
    seedOpencode(db, {
      agent_id: 'O',
      session_id: 'ses_keep',
      name: 'xats-opencode',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: BASE_URL, session_id: 'ses_keep' },
    })
    const obj = await parseTool(resp)

    expect(obj).toMatchObject({ error: 'opencode_unreachable' })
    expect((obj as { detail: { cause: string } }).detail.cause).toMatch(/401/)
    // Row untouched.
    const row = db.prepare(`SELECT last_seen_at FROM agents WHERE agent_id='O'`).get() as { last_seen_at: string }
    expect(row.last_seen_at).toBe('2024-01-02T00:00:00.000Z')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })
})
