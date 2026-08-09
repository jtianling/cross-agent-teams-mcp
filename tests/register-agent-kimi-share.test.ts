import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-kimi-share-'))

const KIMI_SESSION_A = 'session_aaaaaaaa-1111-4111-8111-111111111111'
const KIMI_SESSION_B = 'session_bbbbbbbb-2222-4222-8222-222222222222'
const BASE_URL = 'http://127.0.0.1:58627'

function kimiDelivery(session_id: string) {
  return {
    kind: 'kimi-server' as const,
    session_id,
    base_url: BASE_URL,
  }
}

function registerKimi(
  svc: RegisterAgentService,
  connection_id: string,
  session_id: string
) {
  return svc.register({
    connection_id,
    agent_type: 'kimi-code',
    name: 'kimi-1',
    delivery: kimiDelivery(session_id),
  })
}

describe('RegisterAgentService kimi session share', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function setup(deps: ConstructorParameters<typeof RegisterAgentService>[1] = {}) {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, svc: new RegisterAgentService(db, deps) }
  }

  it('same kimi session can bind the same identity from two connections', () => {
    const closes: string[] = []
    let lines: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
      log: line => { lines = [...lines, line] },
    })
    const first = registerKimi(svc, 'conn-1', KIMI_SESSION_A)
    const second = registerKimi(svc, 'conn-2', KIMI_SESSION_A)
    if ('error' in first || 'error' in second) {
      throw new Error('unexpected error')
    }
    expect(second.agent_id).toBe(first.agent_id)
    expect(closes).toEqual([])
    expect(lines.some(line => line.includes('register_agent takeover')))
      .toBe(false)
  })

  it('different kimi session takes over every connection for the old session', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    registerKimi(svc, 'conn-1', KIMI_SESSION_A)
    registerKimi(svc, 'conn-2', KIMI_SESSION_A)
    expect(closes).toEqual([])

    registerKimi(svc, 'conn-3', KIMI_SESSION_B)
    expect([...closes].sort()).toEqual(['conn-1', 'conn-2'])
  })

  it('releasing one kimi connection preserves its same-session peer', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    registerKimi(svc, 'conn-1', KIMI_SESSION_A)
    const second = registerKimi(svc, 'conn-2', KIMI_SESSION_A)
    if ('error' in second) throw new Error('unexpected error')

    svc.releaseConnection(second.agent_id, 'conn-2')
    registerKimi(svc, 'conn-3', KIMI_SESSION_B)
    expect(closes).toEqual(['conn-1'])
  })

  it('same session_id on a different base_url still takes over', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    registerKimi(svc, 'conn-1', KIMI_SESSION_A)

    // kimi session ids are only unique per server: the same id on another
    // endpoint is a different runtime and must not share.
    const second = svc.register({
      connection_id: 'conn-2',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION_A,
        base_url: 'http://127.0.0.1:59999',
      },
    })
    if ('error' in second) throw new Error('unexpected error')
    expect(closes).toEqual(['conn-1'])
  })

  it('equivalent base_url spellings (case, default port, slash) still share', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    const first = svc.register({
      connection_id: 'conn-1',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION_A,
        base_url: 'http://127.0.0.1',
      },
    })
    const second = svc.register({
      connection_id: 'conn-2',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION_A,
        base_url: 'HTTP://127.0.0.1:80/',
      },
    })
    if ('error' in first || 'error' in second) {
      throw new Error('unexpected error')
    }
    expect(second.agent_id).toBe(first.agent_id)
    expect(closes).toEqual([])
  })

  it('persists the canonical base_url at the service boundary', () => {
    const { db, svc } = setup()
    const res = svc.register({
      connection_id: 'conn-1',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION_A,
        base_url: 'HTTP://127.0.0.1:80/',
      },
    })
    if ('error' in res) throw new Error('unexpected error')
    const row = db.prepare(
      `SELECT delivery_payload FROM agents WHERE agent_id = ?`
    ).get(res.agent_id) as { delivery_payload: string }
    const payload = JSON.parse(row.delivery_payload) as { base_url: string }
    expect(payload.base_url).toBe('http://127.0.0.1')
  })

  it('a trailing-slash base_url variant still shares the runtime', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    registerKimi(svc, 'conn-1', KIMI_SESSION_A)

    const second = svc.register({
      connection_id: 'conn-2',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION_A,
        base_url: `${BASE_URL}/`,
      },
    })
    if ('error' in second) throw new Error('unexpected error')
    expect(closes).toEqual([])
  })

  it('kimi register without a validated kimi-server delivery still takes over', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    registerKimi(svc, 'conn-1', KIMI_SESSION_A)

    const second = svc.register({
      connection_id: 'conn-2',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      delivery: { kind: 'none' },
    })
    if ('error' in second) throw new Error('unexpected error')
    expect(closes).toEqual(['conn-1'])
  })

  it('logs successful connection binds with agent and runtime key', () => {
    let lines: string[] = []
    const { svc } = setup({ log: line => { lines = [...lines, line] } })
    const res = registerKimi(svc, 'conn-1', KIMI_SESSION_A)
    if ('error' in res) throw new Error('unexpected error')

    const bind = lines.find(line => line.includes('register_agent bind'))
    expect(bind).toBeDefined()
    expect(bind).toContain('sid=conn-1')
    expect(bind).toContain(`agent=${res.agent_id}`)
    expect(bind).toContain('team=default name=kimi-1')
    // The runtime key carries the canonical base_url and the session id.
    expect(bind).toContain(KIMI_SESSION_A)
  })

  it('warns when a second agent row claims the same kimi session', () => {
    let lines: string[] = []
    const { svc } = setup({ log: line => { lines = [...lines, line] } })
    registerKimi(svc, 'conn-1', KIMI_SESSION_A)

    const second = svc.register({
      connection_id: 'conn-2',
      agent_type: 'kimi-code',
      name: 'kimi-2',
      delivery: kimiDelivery(KIMI_SESSION_A),
    })
    if ('error' in second) throw new Error('unexpected error')

    const warn = lines.find(line => line.includes('register_agent warn'))
    expect(warn).toBeDefined()
    expect(warn).toContain(KIMI_SESSION_A)
    expect(warn).toContain('(default/kimi-1)')
    expect(warn).toContain('(default/kimi-2)')
  })

  it('does not warn when the same row re-registers its own session', () => {
    let lines: string[] = []
    const { svc } = setup({ log: line => { lines = [...lines, line] } })
    registerKimi(svc, 'conn-1', KIMI_SESSION_A)
    lines = []

    const second = registerKimi(svc, 'conn-2', KIMI_SESSION_A)
    if ('error' in second) throw new Error('unexpected error')
    expect(lines.some(line => line.includes('register_agent warn'))).toBe(false)
  })
})

interface Connected {
  c: Client
  t: StreamableHTTPClientTransport
}

async function connectClient(host: string, port: number): Promise<Connected> {
  const url = new URL(`http://${host}:${port}/mcp`)
  const t = new StreamableHTTPClientTransport(url)
  const c = new Client({ name: 'kimi-share-test', version: '0.0.0' })
  await c.connect(t)
  return { c, t }
}

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('register_agent kimi session share over MCP transport', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('keeps both MCP sessions usable for the same kimi session', async () => {
    const dir = tmp(); cleanups.push(dir)
    let lines: string[] = []
    const { app, port, host } = await startServer({
      dbPath: join(dir, 'data.db'),
      port: 0,
      mcpLog: line => { lines = [...lines, line] },
    })
    const first = await connectClient(host, port)
    const second = await connectClient(host, port)

    try {
      const firstRegistration = await parseTool(await first.c.callTool({
        name: 'register_agent',
        arguments: {
          agent_type: 'kimi-code',
          name: 'kimi-1',
          base_url: BASE_URL,
          session_id: KIMI_SESSION_A,
        },
      }))
      const secondRegistration = await parseTool(await second.c.callTool({
        name: 'register_agent',
        arguments: {
          agent_type: 'kimi-code',
          name: 'kimi-1',
          base_url: BASE_URL,
          session_id: KIMI_SESSION_A,
        },
      }))

      expect(firstRegistration.agent_id).toBeDefined()
      expect(secondRegistration.agent_id).toBe(firstRegistration.agent_id)
      expect(lines.some(line => line.includes('register_agent takeover')))
        .toBe(false)

      const firstInbox = await parseTool(await first.c.callTool({
        name: 'get_inbox',
        arguments: {},
      }))
      expect(firstInbox.error).toBeUndefined()

      await second.t.terminateSession()
      await second.c.close()
      await new Promise(resolve => setTimeout(resolve, 100))

      const firstInboxAfterClose = await parseTool(await first.c.callTool({
        name: 'get_inbox',
        arguments: {},
      }))
      expect(firstInboxAfterClose.error).toBeUndefined()
    } finally {
      const results = await Promise.allSettled([
        first.c.close(),
        second.c.close(),
      ])
      await app.close()
      const failures = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close test clients.')
      }
    }
  }, 15000)
})
