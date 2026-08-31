import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { GetInboxService } from '../src/mcp/get-inbox.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-cursor-mig-'))

function seedEvents(db: import('better-sqlite3').Database, count: number): number {
  const ts = new Date().toISOString()
  const stmt = db.prepare(
    `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?,?)`
  )
  for (let i = 0; i < count; i++) stmt.run('default', 'default', 'message_sent', null, '{}', ts)
  const max = db.prepare(`SELECT MAX(event_id) AS m FROM events`).get() as { m: number | null }
  return max.m ?? 0
}

function readCursor(db: import('better-sqlite3').Database, agentId: string): number {
  const row = db.prepare(`SELECT last_processed_event_id AS c FROM agents WHERE agent_id=?`).get(agentId) as { c: number }
  return row.c
}

/**
 * These used to assert the opposite: that applySchema advanced any cursor
 * sitting at 0 to MAX(event_id).  That behaviour destroyed unread mail, because
 * 0 is also what a legitimate registration writes when the events table is
 * still empty — see the `fix-cursor-watermark-data-loss` change.  The suite is
 * kept under its original name so the history stays findable.
 */
describe('applySchema does not touch inbox cursors', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function freshDb() {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return db
  }

  it('leaves a zero cursor at zero even when events exist', () => {
    const db = freshDb()
    insertAgent(db, { agent_id: 'A' })
    expect(readCursor(db, 'A')).toBe(0)
    seedEvents(db, 7)

    applySchema(db)

    expect(readCursor(db, 'A')).toBe(0)
  })

  it('leaves a non-zero cursor untouched', () => {
    const db = freshDb()
    insertAgent(db, { agent_id: 'A' })
    seedEvents(db, 10)
    db.prepare(`UPDATE agents SET last_processed_event_id=? WHERE agent_id=?`).run(3, 'A')

    applySchema(db)

    expect(readCursor(db, 'A')).toBe(3)
  })

  it('leaves every cursor untouched across repeated applies', () => {
    const db = freshDb()
    insertAgent(db, { agent_id: 'A' })
    insertAgent(db, { agent_id: 'B' })
    seedEvents(db, 12)
    db.prepare(`UPDATE agents SET last_processed_event_id=? WHERE agent_id=?`).run(5, 'B')

    applySchema(db)
    seedEvents(db, 4)
    applySchema(db)
    applySchema(db)

    expect(readCursor(db, 'A')).toBe(0)
    expect(readCursor(db, 'B')).toBe(5)
  })
})

describe('a restart no longer eats mail addressed to a zero-cursor agent', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  /**
   * Uses the REAL registration path, not the insertAgent helper: the whole
   * point is that a genuine `register_agent` on an empty events table produces
   * cursor 0, which the old sentinel could not tell apart from a legacy row.
   */
  it('keeps the message readable after applySchema re-runs', async () => {
    const dir = tmp(); dirs.push(dir)
    const path = join(dir, 'data.db')
    const db = openDb(path)
    applySchema(db)

    const agents = new AgentsRepo(db)
    const a = agents.register({ name: 'A', team: 't', role: 'r', model: 'm', agent_type: 'custom' } as never) as unknown as { agent_id: string }
    const b = agents.register({ name: 'B', team: 't', role: 'r', model: 'm', agent_type: 'custom' } as never) as unknown as { agent_id: string }

    // Registered while `events` was empty, so this 0 is a correct cursor.
    expect(readCursor(db, b.agent_id)).toBe(0)

    const send = new SendMessageService(db, agents, new EventsOutbox(db), { poke: async () => ({ ok: true }) })
    const sent = await send.send({
      from: a.agent_id, to_agent_id: b.agent_id, body: 'important', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')

    // The restart: applySchema runs on every daemon boot.
    applySchema(db)

    expect(readCursor(db, b.agent_id)).toBe(0)
    const inbox = new GetInboxService(db, new AgentsRepo(db)).get({ caller: b.agent_id })
    expect(inbox.messages.map(m => m.body)).toContain('important')
    db.close()
  })

  it('hands out a valid zero cursor again after retention empties the events table', () => {
    // The defect was never confined to a brand-new database: cleanup applies a
    // 30-day TTL to `events`, so any deployment that goes quiet for that long
    // is back in the old migration's line of fire the next time an agent joins.
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    seedEvents(db, 5)
    db.prepare(`DELETE FROM events`).run()

    const agents = new AgentsRepo(db)
    const late = agents.register({ name: 'late', team: 't', role: 'r', model: 'm', agent_type: 'custom' } as never) as unknown as { agent_id: string }
    expect(readCursor(db, late.agent_id)).toBe(0)

    applySchema(db)

    expect(readCursor(db, late.agent_id)).toBe(0)
    db.close()
  })

  it('registers a valid zero cursor when the events table is empty', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)

    const agents = new AgentsRepo(db)
    const row = agents.register({ name: 'solo', team: 't', role: 'r', model: 'm', agent_type: 'custom' } as never) as unknown as { agent_id: string }

    expect(readCursor(db, row.agent_id)).toBe(0)
    db.close()
  })
})
