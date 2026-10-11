import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import {
  FANOUT_ACTIVE_WINDOW_MS,
  fanoutActiveCutoff,
} from '../src/mcp/fanout-active-window.js'
import { insertAgent } from './helpers/insert-agent.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  execFileSync: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  spawn: vi.fn(() => { throw new Error('Unexpected subprocess') }),
}))

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

type Db = ReturnType<typeof openDb>
type Reply = Record<string, unknown> & {
  recipients?: string[]
  messages?: Array<{ body: string }>
}

interface Harness {
  db: Db
  call: (as: string, name: string, args: Record<string, unknown>) => Promise<Reply>
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function member(db: Db, agent_id: string, idleMs = 0, role = 'worker'): void {
  insertAgent(db, { agent_id, role, last_seen_at: ago(idleMs) })
}

function counts(db: Db): { events: number; messages: number; status: number } {
  const n = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  return {
    events: n('events'),
    messages: n('messages'),
    status: n('message_delivery_status'),
  }
}

function mailFor(db: Db, agent_id: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE to_agent_id=?')
    .get(agent_id) as { c: number }).c
}

describe('fan-out activity window', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closers) await close()
    closers.length = 0
  })

  async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), 'atm-fanout-window-'))
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const server = new McpServer({ name: 'test', version: '1' })
    const client = new Client({ name: 'test', version: '1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    let bound = ''
    registerBusinessTools(server, db, () => bound || undefined)
    await server.connect(st)
    await client.connect(ct)
    closers.push(async () => {
      await client.close()
      await server.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const call: Harness['call'] = async (as, name, args) => {
      bound = as
      const resp = await client.callTool({ name, arguments: args })
      return JSON.parse((resp.content as Array<{ text: string }>)[0].text)
    }
    return { db, call }
  }

  it('the window is seven days', () => {
    expect(FANOUT_ACTIVE_WINDOW_MS).toBe(7 * DAY)
    const now = new Date('2026-01-08T00:00:00.000Z')
    expect(fanoutActiveCutoff(now)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('broadcast addresses recently active members and skips the rest', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', MIN)
    member(db, 'C', 3 * DAY)
    member(db, 'D', 8 * DAY)

    const r = await call('A', 'broadcast', { body: 'status', auto_poke: false })

    expect([...r.recipients!].sort()).toEqual(['B', 'C'])
    expect(r.skipped_inactive).toBe(1)
    expect([mailFor(db, 'B'), mailFor(db, 'C'), mailFor(db, 'D')])
      .toEqual([1, 1, 0])
    const ev = db.prepare('SELECT payload FROM events WHERE event_id=?')
      .get(r.event_id) as { payload: string }
    expect([...JSON.parse(ev.payload).recipients].sort()).toEqual(['B', 'C'])
    const status = db.prepare(
      'SELECT agent_id FROM message_delivery_status ORDER BY agent_id'
    ).all() as Array<{ agent_id: string }>
    expect(status.map(s => s.agent_id)).toEqual(['B', 'C'])
  })

  it('a member just inside the window is addressed', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', 6 * DAY + 23 * HOUR)

    const r = await call('A', 'broadcast', { body: 'hello', auto_poke: false })

    expect(r.recipients).toEqual(['B'])
    expect(r.skipped_inactive).toBe(0)
  })

  it('a member just outside the window is skipped', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', MIN)
    member(db, 'C', 7 * DAY + HOUR)

    const r = await call('A', 'broadcast', { body: 'hello', auto_poke: false })

    expect(r.recipients).toEqual(['B'])
    expect(r.skipped_inactive).toBe(1)
  })

  it('reading mail brings a member back inside the window', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', 8 * DAY)

    await call('B', 'get_inbox', {})
    const r = await call('A', 'broadcast', { body: 'hello', auto_poke: false })

    expect(r.recipients).toEqual(['B'])
    expect(r.skipped_inactive).toBe(0)
  })

  it('a sole member gets unknown_recipient without a count', async () => {
    const { db, call } = await harness()
    member(db, 'A')

    const r = await call('A', 'broadcast', { body: 'hello', auto_poke: false })

    expect(r).toEqual({ error: 'unknown_recipient' })
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })

  it('all-inactive peers give unknown_recipient with the count', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', 8 * DAY)
    member(db, 'C', 20 * DAY)

    const r = await call('A', 'broadcast', { body: 'hello', auto_poke: false })

    expect(r).toEqual({ error: 'unknown_recipient', skipped_inactive: 2 })
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })

  it('channel proxy rows are neither addressed nor counted', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', MIN)
    member(db, 'P', 8 * DAY, '__channel_proxy__')

    const r = await call('A', 'broadcast', { body: 'hello', auto_poke: false })

    expect(r.recipients).toEqual(['B'])
    expect(r.skipped_inactive).toBe(0)
  })

  it('broadcast_to_role skips inactive role holders', async () => {
    const { db, call } = await harness()
    member(db, 'A', 0, 'lead')
    member(db, 'F1', MIN, 'frontend')
    member(db, 'F2', 2 * HOUR, 'frontend')
    member(db, 'F3', 10 * DAY, 'frontend')
    member(db, 'W', 10 * DAY, 'worker')

    const r = await call('A', 'broadcast_to_role', {
      to_role: 'frontend', body: 'hi frontends', auto_poke: false,
    })

    expect([...r.recipients!].sort()).toEqual(['F1', 'F2'])
    expect(r.skipped_inactive).toBe(1)
    expect(mailFor(db, 'F3')).toBe(0)
  })

  it('broadcast_to_role reports zero skipped when all holders are active', async () => {
    const { db, call } = await harness()
    member(db, 'A', 0, 'lead')
    member(db, 'F1', MIN, 'frontend')

    const r = await call('A', 'broadcast_to_role', {
      to_role: 'frontend', body: 'hi', auto_poke: false,
    })

    expect(r.recipients).toEqual(['F1'])
    expect(r.skipped_inactive).toBe(0)
  })

  it('only inactive role holders give unknown_recipient with the count', async () => {
    const { db, call } = await harness()
    member(db, 'A', 0, 'lead')
    member(db, 'W', 9 * DAY, 'worker')

    const r = await call('A', 'broadcast_to_role', {
      to_role: 'worker', body: 'hi', auto_poke: false,
    })

    expect(r).toEqual({ error: 'unknown_recipient', skipped_inactive: 1 })
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })

  it('a role nobody holds gives unknown_recipient without a count', async () => {
    const { db, call } = await harness()
    member(db, 'A', 0, 'lead')
    member(db, 'W', 9 * DAY, 'worker')

    const r = await call('A', 'broadcast_to_role', {
      to_role: 'archivist', body: 'anything', auto_poke: false,
    })

    expect(r).toEqual({ error: 'unknown_recipient' })
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })

  it('send_message reaches an agent idle past the broadcast window', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', 20 * DAY)

    const sent = await call('A', 'send_message', {
      to_agent_name: 'B', body: 'ping', auto_poke: false, await_ack_s: 0,
    })

    expect(typeof sent.message_id).toBe('string')
    expect(sent.recipients).toEqual(['B'])
    expect(mailFor(db, 'B')).toBe(1)
    const inbox = await call('B', 'get_inbox', {})
    expect(inbox.messages!.map(m => m.body)).toEqual(['ping'])
  })

  it('send_message_by_id reaches an agent idle for 29 days', async () => {
    const { db, call } = await harness()
    member(db, 'A')
    member(db, 'B', 29 * DAY)

    const sent = await call('A', 'send_message_by_id', {
      to_agent_id: 'B', body: 'ping', auto_poke: false, await_ack_s: 0,
    })

    expect(typeof sent.message_id).toBe('string')
    expect(mailFor(db, 'B')).toBe(1)
    const inbox = await call('B', 'get_inbox', {})
    expect(inbox.messages!.map(m => m.body)).toEqual(['ping'])
  })
})
