import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-unregister-self-'))
const { detectTmuxPaneMock } = vi.hoisted(() => ({
  detectTmuxPaneMock: vi.fn(),
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const result = resp as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0].text)
}

describe('unregister_self', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    detectTmuxPaneMock.mockReset()
  })

  it('successfully unregisters the current agent and clears same-session identity', async () => {
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const transport = new StreamableHTTPClientTransport(url)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)

    const registered = await parseTool(await client.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', model: 'opus', name: 'alice', role: 'worker' },
    }))
    const agentId = registered.agent_id as string

    const db = openDb(dbPath)
    const unregistered = await parseTool(await client.callTool({
      name: 'unregister_self',
      arguments: {},
    }))
    expect(unregistered).toEqual({
      ok: true,
      team: 'default',
      name: 'alice',
      agent_id: agentId,
    })

    const agentRow = db.prepare(`SELECT agent_id FROM agents WHERE agent_id=?`).get(agentId) as
      | { agent_id: string }
      | undefined
    expect(agentRow).toBeUndefined()

    const inbox = await parseTool(await client.callTool({
      name: 'get_inbox',
      arguments: {},
    }))
    expect(inbox).toMatchObject({ error: 'unknown_agent' })

    const reregistered = await parseTool(await client.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', model: 'opus', name: 'alice', role: 'worker' },
    }))
    expect(reregistered.agent_id).toBeDefined()
    expect(reregistered.agent_id).not.toBe(agentId)

    db.close()
    await transport.terminateSession()
    await client.close()
    await app.close()
  })

  it('unregisters even if a prior-version legacy tasks table has an owned in-progress task', async () => {
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const transport = new StreamableHTTPClientTransport(url)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)

    const registered = await parseTool(await client.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', model: 'opus', name: 'alice', role: 'worker' },
    }))
    const agentId = registered.agent_id as string

    const db = openDb(dbPath)
    db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      team TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      result TEXT,
      created_at TEXT NOT NULL
    )`)
    db.prepare(
      `INSERT INTO tasks (id, team, title, description, status, depends_on, claimed_by, claimed_at, completed_at, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'T1',
      'default',
      'Keep working',
      null,
      'in_progress',
      '[]',
      agentId,
      new Date().toISOString(),
      null,
      null,
      new Date().toISOString()
    )

    const result = await parseTool(await client.callTool({
      name: 'unregister_self',
      arguments: {},
    }))
    expect(result).toEqual({
      ok: true,
      team: 'default',
      name: 'alice',
      agent_id: agentId,
    })

    const agentRow = db.prepare(`SELECT agent_id FROM agents WHERE agent_id=?`).get(agentId) as
      | { agent_id: string }
      | undefined
    expect(agentRow).toBeUndefined()

    db.close()
    await transport.terminateSession()
    await client.close()
    await app.close()
  })

  it('returns unknown_agent for an unregistered session', async () => {
    const dir = tmp()
    cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const transport = new StreamableHTTPClientTransport(url)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)

    const result = await parseTool(await client.callTool({
      name: 'unregister_self',
      arguments: {},
    }))
    expect(result).toMatchObject({ error: 'unknown_agent' })
    expect(result.hint).toContain('reconnect')
    expect(result.hint).toContain('kimi-code')
    expect(result.hint).toContain('claude-code')
    expect(result.hint).toContain('register_agent')

    await transport.terminateSession()
    await client.close()
    await app.close()
  })
})
