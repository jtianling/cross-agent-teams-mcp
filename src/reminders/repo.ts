import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  snapshotSchema, type Snapshot, type Watch, type WatchInput,
} from './schema.js'
import { ensureReminderSchema } from './migration.js'

type StoredWatch = Watch & { snapshot_json: string }

export class ReminderWatchesRepo {
  constructor(private db: Database.Database) {
    ensureReminderSchema(db)
  }

  list(): Watch[] {
    const rows = this.db.prepare(`SELECT id, list_id, to_team, to_agent_name,
      event, tag,
      created_at, checked_at, last_error FROM reminder_watches
      ORDER BY created_at, id`).all() as Watch[]
    return rows.map(row => publicWatch(row))
  }

  get(id: string): StoredWatch | undefined {
    const row = this.db.prepare('SELECT * FROM reminder_watches WHERE id=?')
      .get(id) as StoredWatch | undefined
    return row ? { ...publicWatch(row), snapshot_json: row.snapshot_json } : undefined
  }

  snapshot(watch: StoredWatch): Snapshot {
    return snapshotSchema.parse(JSON.parse(watch.snapshot_json))
  }

  add(input: WatchInput, snapshot: Snapshot, now: number): Watch {
    const id = randomUUID()
    const time = new Date(now).toISOString()
    this.db.prepare(`INSERT INTO reminder_watches
      (id, list_id, to_team, to_agent_name, event, tag, snapshot_json,
       created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.list_id, input.to_team, input.to_agent_name,
        input.event, input.event === 'tag' ? input.tag : '',
        JSON.stringify(snapshot), time, time)
    return this.list().find(watch => watch.id === id)!
  }

  save(id: string, snapshot: Snapshot, now: number): void {
    this.db.prepare(`UPDATE reminder_watches
      SET snapshot_json=?, checked_at=?, last_error=NULL WHERE id=?`)
      .run(JSON.stringify(snapshot), new Date(now).toISOString(), id)
  }

  fail(id: string, error: string): void {
    this.db.prepare('UPDATE reminder_watches SET last_error=? WHERE id=?')
      .run(error, id)
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM reminder_watches WHERE id=?')
      .run(id).changes > 0
  }
}

function publicWatch(row: Watch): Watch {
  if (row.event === 'tag') return row
  const { tag: _tag, ...rest } = row as Watch & { tag?: string }
  return rest as Watch
}
