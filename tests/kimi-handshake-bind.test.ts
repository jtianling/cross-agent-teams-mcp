import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { mountMcp } from '../src/mcp/transport.js'
import { SseFanout } from '../src/daemon/sse-fanout.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-kimi-handshake-'))

const TOKEN_ENV = 'XATS_TEST_KIMI_HANDSHAKE_TOKEN'
const SESSION_ID = 'session_handshake_test'

interface FakeKimi {
  url: string
  close: () => Promise<void>
  setMode: (mode: 'ok' | 'not_found') => void
  probes: string[]
}

/** Fake kimi server: GET /api/v1/sessions/<id> answers the strict envelope. */
async function bootFakeKimi(): Promise<FakeKimi> {
  let mode: 'ok' | 'not_found' = 'ok'
  const probes: string[] = []
  const server: Server = createServer((req, res) => {
    const m = /^\/api\/v1\/sessions\/([^/]+)$/.exec(req.url ?? '')
    if (!m) {
      res.writeHead(404).end()
      return
    }
    const id = decodeURIComponent(m[1])
    probes.push(id)
    if (mode === 'not_found') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, msg: 'ok', data: { id } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
    setMode: next => { mode = next },
    probes,
  }
}

interface Harness {
  port: number
  close: () => Promise<void>
}

async function bootDaemon(dbPath: string): Promise<Harness> {
  const app = Fastify({ logger: false })
  const db = openDb(dbPath)
  applySchema(db)
  const fanout = new SseFanout()
  mountMcp(app, db, fanout)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  return {
    port,
    close: async () => {
      await app.close()
      fanout.stopAll()
      db.close()
    },
  }
}

function seedKimiAgent(
  dbPath: string,
  args: { agent_id: string; name: string; base_url: string; session_id: string }
): void {
  const db = openDb(dbPath)
  db.prepare(
    `INSERT INTO agents (
       agent_id, agent_type, device, team, role, name, registered_at, last_seen_at,
       delivery_kind, delivery_payload, last_processed_event_id
     ) VALUES (?, 'kimi-code', 'local', 'default', 'worker', ?, ?, ?, 'kimi-server', ?, 0)`
  ).run(
    args.agent_id,
    args.name,
    '2026-08-07T00:00:00.000Z',
    '2026-08-07T00:00:00.000Z',
    JSON.stringify({
      kind: 'kimi-server',
      base_url: args.base_url,
      session_id: args.session_id,
      auth_token_ref: TOKEN_ENV,
    })
  )
  db.close()
}

async function connectWithHeaders(
  port: number,
  headers: Record<string, string>
): Promise<{ c: Client; t: StreamableHTTPClientTransport }> {
  const t = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers } }
  )
  const c = new Client({ name: 'handshake-test', version: '0.0.0' })
  await c.connect(t)
  return { c, t }
}

async function getInbox(c: Client): Promise<Record<string, unknown>> {
  const r = await c.callTool({ name: 'get_inbox', arguments: {} })
  const content = (r as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0].text)
}

async function rawPost(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
  sid?: string
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(sid ? { 'mcp-session-id': sid } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('kimi handshake-level identity bind', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  beforeEach(() => {
    process.env[TOKEN_ENV] = 'test-token'
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env[TOKEN_ENV]
    // LIFO: clients must close before the daemon, or Fastify app.close()
    // waits forever on the client's open SSE stream.
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('binds a fresh session via X-Kimi-Session-Id + X-Kimi-Base-Url at initialize', async () => {
    const dir = tmp(); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const kimi = await bootFakeKimi(); cleanups.push(kimi.close)
    const dbPath = join(dir, 'data.db')
    const h = await bootDaemon(dbPath); cleanups.push(h.close)
    seedKimiAgent(dbPath, {
      agent_id: 'agent-1', name: 'kimi-1', base_url: kimi.url, session_id: SESSION_ID,
    })

    const { c, t } = await connectWithHeaders(h.port, {
      'x-kimi-session-id': SESSION_ID,
      'x-kimi-base-url': kimi.url,
    })
    cleanups.push(async () => { await t.close(); await c.close() })

    const inbox = await getInbox(c)
    expect(inbox).toMatchObject({ messages: [] })
    expect(kimi.probes).toContain(SESSION_ID)
  })

  it('binds via session_id reverse lookup when X-Kimi-Base-Url is absent', async () => {
    const dir = tmp(); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const kimi = await bootFakeKimi(); cleanups.push(kimi.close)
    const dbPath = join(dir, 'data.db')
    const h = await bootDaemon(dbPath); cleanups.push(h.close)
    seedKimiAgent(dbPath, {
      agent_id: 'agent-1', name: 'kimi-1', base_url: kimi.url, session_id: SESSION_ID,
    })

    const { c, t } = await connectWithHeaders(h.port, {
      'x-kimi-session-id': SESSION_ID,
    })
    cleanups.push(async () => { await t.close(); await c.close() })

    expect(await getInbox(c)).toMatchObject({ messages: [] })
  })

  it('stays unbound when no agent row claims the session id', async () => {
    const dir = tmp(); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const dbPath = join(dir, 'data.db')
    const h = await bootDaemon(dbPath); cleanups.push(h.close)

    const { c, t } = await connectWithHeaders(h.port, {
      'x-kimi-session-id': SESSION_ID,
    })
    cleanups.push(async () => { await t.close(); await c.close() })

    expect(await getInbox(c)).toMatchObject({ error: 'unknown_agent' })
  })

  it('stays unbound on probe failure and retries on a later request', async () => {
    const dir = tmp(); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const kimi = await bootFakeKimi(); cleanups.push(kimi.close)
    kimi.setMode('not_found')
    const dbPath = join(dir, 'data.db')
    const h = await bootDaemon(dbPath); cleanups.push(h.close)
    seedKimiAgent(dbPath, {
      agent_id: 'agent-1', name: 'kimi-1', base_url: kimi.url, session_id: SESSION_ID,
    })

    const { c, t } = await connectWithHeaders(h.port, {
      'x-kimi-session-id': SESSION_ID,
      'x-kimi-base-url': kimi.url,
    })
    cleanups.push(async () => { await t.close(); await c.close() })

    expect(await getInbox(c)).toMatchObject({ error: 'unknown_agent' })
    kimi.setMode('ok')
    expect(await getInbox(c)).toMatchObject({ messages: [] })
  })

  it('fails closed when the session id is ambiguous without a base_url', async () => {
    const dir = tmp(); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const kimi = await bootFakeKimi(); cleanups.push(kimi.close)
    const dbPath = join(dir, 'data.db')
    const h = await bootDaemon(dbPath); cleanups.push(h.close)
    seedKimiAgent(dbPath, {
      agent_id: 'agent-1', name: 'kimi-1', base_url: kimi.url, session_id: SESSION_ID,
    })
    seedKimiAgent(dbPath, {
      agent_id: 'agent-2', name: 'kimi-2',
      base_url: 'http://127.0.0.1:59999', session_id: SESSION_ID,
    })

    const { c, t } = await connectWithHeaders(h.port, {
      'x-kimi-session-id': SESSION_ID,
    })
    cleanups.push(async () => { await t.close(); await c.close() })

    expect(await getInbox(c)).toMatchObject({ error: 'unknown_agent' })
    expect(kimi.probes).toHaveLength(0)
  })

  it('binds on the first header-bearing non-init request', async () => {
    const dir = tmp(); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const kimi = await bootFakeKimi(); cleanups.push(kimi.close)
    const dbPath = join(dir, 'data.db')
    const h = await bootDaemon(dbPath); cleanups.push(h.close)
    seedKimiAgent(dbPath, {
      agent_id: 'agent-1', name: 'kimi-1', base_url: kimi.url, session_id: SESSION_ID,
    })

    // initialize WITHOUT identity headers, then present them on tools/call.
    const init = await rawPost(h.port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    })
    const sid = init.headers.get('mcp-session-id')!
    await rawPost(h.port, { jsonrpc: '2.0', method: 'notifications/initialized' }, {}, sid)

    const res = await rawPost(
      h.port,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_inbox', arguments: {} } },
      { 'x-kimi-session-id': SESSION_ID, 'x-kimi-base-url': kimi.url },
      sid
    )
    const text = await res.text()
    const dataLine = text.split('\n').find(l => l.startsWith('data:'))!
    const payload = JSON.parse(
      JSON.parse(dataLine.slice(5)).result.content[0].text
    ) as Record<string, unknown>
    expect(payload).toMatchObject({ messages: [] })
  })
})
