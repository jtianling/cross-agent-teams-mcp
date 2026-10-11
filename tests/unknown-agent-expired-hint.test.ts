import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { runCleanup } from '../src/daemon/cleanup.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { insertAgent } from './helpers/insert-agent.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  execFileSync: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  spawn: vi.fn(() => { throw new Error('Unexpected subprocess') }),
}))

const DAY_MS = 86400 * 1000

describe('unknown_agent hint for an expired registration', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  async function getInbox(
    bound: string | undefined,
    seed: (db: ReturnType<typeof openDb>) => void,
    sessionId?: string
  ): Promise<{ error?: string; hint?: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'atm-expired-hint-'))
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    seed(db)
    const server = new McpServer({ name: 'test', version: '1' })
    const client = new Client({ name: 'test', version: '1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    registerBusinessTools(
      server, db, () => bound, undefined, undefined, () => sessionId
    )
    await server.connect(st)
    await client.connect(ct)
    try {
      const resp = await client.callTool({ name: 'get_inbox', arguments: {} })
      return JSON.parse((resp.content as Array<{ text: string }>)[0].text)
    } finally {
      await client.close()
      await server.close()
      db.close()
    }
  }

  it('tells a session whose row cleanup removed to reconnect then register', async () => {
    const inbox = await getInbox('old', db => {
      insertAgent(db, {
        agent_id: 'old',
        last_seen_at: new Date(Date.now() - 31 * DAY_MS).toISOString(),
      })
      runCleanup(db)
    })

    expect(inbox.error).toBe('unknown_agent')
    expect(inbox.hint).toContain('no longer exists')
    expect(inbox.hint).toContain('removed')
    expect(inbox.hint).toContain('30-day')
    expect(inbox.hint).toContain('reconnect')
    expect(inbox.hint).toContain('need_register')
    expect(inbox.hint).toContain('register_agent')
    expect(inbox.hint).toContain('new agent_id')
    expect(inbox.hint).not.toContain('registration persists')
  })

  it('keeps the per-connection hint for a session bound to nobody', async () => {
    const inbox = await getInbox(undefined, () => {})

    expect(inbox.error).toBe('unknown_agent')
    expect(inbox.hint).toContain('registration persists')
    expect(inbox.hint).toContain('kimi-code')
    expect(inbox.hint).toContain('claude-code')
    expect(inbox.hint).toContain('register_agent')
    expect(inbox.hint).not.toContain('no longer exists')
  })

  // Before registration the caller id IS the session id, so a missing row
  // there means "never bound", not "expired".
  it('treats a caller id equal to the session id as unbound', async () => {
    const inbox = await getInbox('sid-1', () => {}, 'sid-1')

    expect(inbox.error).toBe('unknown_agent')
    expect(inbox.hint).toContain('registration persists')
    expect(inbox.hint).not.toContain('no longer exists')
  })

  it('reports expiry when the bound agent id differs from the session id', async () => {
    const inbox = await getInbox('gone', () => {}, 'sid-1')

    expect(inbox.hint).toContain('no longer exists')
    expect(inbox.hint).not.toContain('registration persists')
  })
})
