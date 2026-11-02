import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

const WATCHES_DDL = `CREATE TABLE reminder_watches (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  to_team TEXT NOT NULL,
  to_agent_name TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('added', 'completed', 'tag')),
  tag TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  last_error TEXT,
  UNIQUE(list_id, to_team, to_agent_name, event, tag)
)`

interface LegacyWatch {
  id: string
  list_id: string
  to_team: string
  to_agent_name: string
  snapshot_json: string
  created_at: string
  checked_at: string | null
  last_error: string | null
}

export function ensureReminderSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(reminder_watches)')
    .all() as Array<{ name: string }>
  if (columns.length === 0) { db.exec(WATCHES_DDL); return }
  if (columns.some(column => column.name === 'event')) return
  db.transaction(() => {
    const old = db.prepare('SELECT * FROM reminder_watches')
      .all() as LegacyWatch[]
    db.exec('ALTER TABLE reminder_watches RENAME TO reminder_watches_legacy')
    db.exec(WATCHES_DDL)
    const insert = db.prepare(`INSERT INTO reminder_watches
      (id, list_id, to_team, to_agent_name, event, tag, snapshot_json,
       created_at, checked_at, last_error) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`)
    for (const row of old) {
      insert.run(row.id, row.list_id, row.to_team, row.to_agent_name,
        'added', row.snapshot_json, row.created_at, row.checked_at, row.last_error)
      insert.run(randomUUID(), row.list_id, row.to_team, row.to_agent_name,
        'completed', row.snapshot_json, row.created_at,
        row.checked_at, row.last_error)
    }
    db.exec('DROP TABLE reminder_watches_legacy')
  })()
}
