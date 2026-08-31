import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { runUnreadWatchdogScan } from '../src/mcp/unread-watchdog.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-ack-schema-'))

interface ColumnInfo { name: string; notnull: number; dflt_value: string | null }

describe('messages ack columns', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function freshDb() {
    const dir = tmp(); dirs.push(dir)
    return openDb(join(dir, 'data.db'))
  }

  it('creates ack_deadline_at and ack_alerted_at as nullable columns', () => {
    const db = freshDb()
    applySchema(db)
    const cols = db.pragma('table_info(messages)') as ColumnInfo[]
    const byName = new Map(cols.map(c => [c.name, c]))
    expect(byName.has('ack_deadline_at')).toBe(true)
    expect(byName.has('ack_alerted_at')).toBe(true)
    expect(byName.get('ack_deadline_at')!.notnull).toBe(0)
    expect(byName.get('ack_alerted_at')!.notnull).toBe(0)
  })

  it('migrates a legacy messages table without arming any pre-existing row', () => {
    const db = freshDb()
    // Legacy shape: the table as it existed before this change.
    db.exec(`CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_team TEXT NOT NULL, to_team TEXT NOT NULL, event_type TEXT NOT NULL,
      actor_agent_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL)`)
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(event_id),
      from_team TEXT NOT NULL, to_team TEXT NOT NULL,
      from_agent_id TEXT NOT NULL, to_agent_id TEXT, to_role TEXT,
      subject TEXT, body TEXT NOT NULL,
      need_reply INTEGER NOT NULL DEFAULT 1, sent_at TEXT NOT NULL)`)
    db.prepare(
      `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at)
       VALUES ('t','t','message_sent','A','{}','2020-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, body, need_reply, sent_at)
       VALUES ('old', 1, 't', 't', 'A', 'B', 'legacy', 1, '2020-01-01T00:00:00.000Z')`
    ).run()

    applySchema(db)

    const row = db.prepare(
      `SELECT ack_deadline_at, ack_alerted_at FROM messages WHERE id='old'`
    ).get() as { ack_deadline_at: string | null; ack_alerted_at: string | null }
    expect(row.ack_deadline_at).toBeNull()
    expect(row.ack_alerted_at).toBeNull()
  })

  it('emits no alert for a pre-existing row after migration', async () => {
    const db = freshDb()
    db.exec(`CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_team TEXT NOT NULL, to_team TEXT NOT NULL, event_type TEXT NOT NULL,
      actor_agent_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL)`)
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(event_id),
      from_team TEXT NOT NULL, to_team TEXT NOT NULL,
      from_agent_id TEXT NOT NULL, to_agent_id TEXT, to_role TEXT,
      subject TEXT, body TEXT NOT NULL,
      need_reply INTEGER NOT NULL DEFAULT 1, sent_at TEXT NOT NULL)`)
    db.prepare(
      `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at)
       VALUES ('t','t','message_sent','A','{}','2020-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, body, need_reply, sent_at)
       VALUES ('old', 1, 't', 't', 'A', 'B', 'legacy', 1, '2020-01-01T00:00:00.000Z')`
    ).run()

    applySchema(db)
    // Closes the loop the schema assertion alone leaves open: an upgrade must
    // not alert on years of historical mail, however far past any deadline.
    const rec: string[] = []
    const out = await runUnreadWatchdogScan({
      db,
      pokeFn: async target => { rec.push(target); return { ok: true, transport_used: 'claude-channel', channel_session_id: 'cs' } },
      now: () => Date.now() + 10 * 365 * 24 * 3600_000,
    })

    expect(out).toEqual({ examined: 0, alerted: 0, retrying: 0 })
    expect(rec).toHaveLength(0)
  })

  it('never reuses an event id after a retention purge', () => {
    const db = freshDb()
    applySchema(db)
    const insert = db.prepare(
      `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at)
       VALUES ('t','t','message_sent',NULL,'{}',?)`
    )
    insert.run('2020-01-01T00:00:00.000Z')
    insert.run('2020-01-02T00:00:00.000Z')
    const before = db.prepare(`SELECT MAX(event_id) AS m FROM events`).get() as { m: number }

    // Cleanup deletes aged events. Under a plain rowid alias the next insert
    // would restart at 1, and an agent whose cursor sat high would then judge
    // every new message as already read — a silent loss worse than any failure
    // this capability addresses. AUTOINCREMENT is what prevents it.
    db.prepare(`DELETE FROM events`).run()
    insert.run('2026-01-01T00:00:00.000Z')
    const after = db.prepare(`SELECT MAX(event_id) AS m FROM events`).get() as { m: number }

    expect(after.m).toBeGreaterThan(before.m)
  })

  it('declares events.event_id AUTOINCREMENT', () => {
    const db = freshDb()
    applySchema(db)
    const ddl = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`
    ).get() as { sql: string }
    expect(ddl.sql).toMatch(/AUTOINCREMENT/i)
  })

  it('stores no read column anywhere — read stays derived', () => {
    const db = freshDb()
    applySchema(db)
    for (const table of ['messages', 'message_delivery_status']) {
      const names = (db.pragma(`table_info(${table})`) as ColumnInfo[]).map(c => c.name)
      expect(names.some(n => /^read|read_at$|_read$/.test(n)), `${table} must not store a read flag`).toBe(false)
    }
  })

  it('is idempotent across repeated applySchema runs', () => {
    const db = freshDb()
    applySchema(db)
    expect(() => applySchema(db)).not.toThrow()
    const cols = db.pragma('table_info(messages)') as ColumnInfo[]
    expect(cols.filter(c => c.name === 'ack_deadline_at')).toHaveLength(1)
  })
})
