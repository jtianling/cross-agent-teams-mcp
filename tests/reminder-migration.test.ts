import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/storage/db.js'
import { ReminderWatchesRepo } from '../src/reminders/repo.js'

const LIST = 'bfe44969-fcb1-49a2-a9c3-a4c711f83bbd'
const databases: ReturnType<typeof openDb>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function legacy(snapshot = JSON.stringify({ task: {
  fingerprint: 'old-fingerprint', completed: false, announced: false,
  stable_since: 1234,
} })) {
  const db = openDb(':memory:')
  databases.push(db)
  db.exec(`CREATE TABLE reminder_watches (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, to_team TEXT NOT NULL,
    to_agent_name TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL, checked_at TEXT, last_error TEXT,
    UNIQUE(list_id, to_team, to_agent_name))`)
  db.prepare(`INSERT INTO reminder_watches VALUES
    ('old-id', ?, 'work', 'worker', ?, 'created', 'checked', 'previous-error')`)
    .run(LIST, snapshot)
  return db
}

describe('reminder rule migration', () => {
  it('splits combined rules atomically and preserves snapshots and IDs', () => {
    const db = legacy()
    const repo = new ReminderWatchesRepo(db)
    const watches = repo.list()
    expect(watches).toHaveLength(2)
    const added = watches.find(watch => watch.event === 'added')!
    const completed = watches.find(watch => watch.event === 'completed')!
    expect(added.id).toBe('old-id')
    expect(completed.id).not.toBe(added.id)
    expect(added).not.toHaveProperty('tag')
    expect(completed).toMatchObject({
      to_team: 'work', to_agent_name: 'worker', checked_at: 'checked',
      last_error: 'previous-error',
    })
    expect(repo.snapshot(repo.get(added.id)!).task).toMatchObject({
      announced: false, stable_since: 1234, fingerprint: 'old-fingerprint',
    })
    expect(repo.snapshot(repo.get(completed.id)!).task).toMatchObject({
      announced: false, completed: false, stable_since: 1234,
    })
    expect(new ReminderWatchesRepo(db).list()).toEqual(watches)
  })

  it('preserves malformed legacy data for isolated per-rule error handling', () => {
    const db = legacy('invalid-json')
    const repo = new ReminderWatchesRepo(db)
    expect(repo.list()).toHaveLength(2)
    for (const watch of repo.list()) {
      const stored = repo.get(watch.id)!
      expect(stored.snapshot_json).toBe('invalid-json')
      expect(() => repo.snapshot(stored)).toThrow()
    }
    expect(db.prepare(`SELECT name FROM sqlite_master
      WHERE name='reminder_watches_legacy'`).get()).toBeUndefined()
  })
})
