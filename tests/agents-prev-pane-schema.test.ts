import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-prev-pane-'))

// An agents table as it stands in a deployed database: everything the current
// schema has except the new column.
function createPrePaneMemoryAgents(db: Database.Database): void {
  db.exec(`CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    agent_type TEXT,
    agent_type_name TEXT,
    device TEXT NOT NULL,
    team TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0,
    tmux_pane_id TEXT,
    claude_ui_pid INTEGER,
    runtime_ui_pid INTEGER,
    runtime_tty TEXT,
    runtime_verification_mode TEXT,
    runtime_bound_at TEXT,
    channel_session_id TEXT,
    delivery_kind TEXT NOT NULL DEFAULT 'none',
    delivery_payload TEXT,
    remote_addr TEXT,
    identity_key TEXT,
    register_generation INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec(`CREATE UNIQUE INDEX agents_identity_idx ON agents(device, team, name)`)
}

function prevPaneColumn(
  db: Database.Database
): { type: string; notnull: number } | undefined {
  const cols = db.pragma('table_info(agents)') as Array<{
    name: string
    type: string
    notnull: number
  }>
  const col = cols.find(c => c.name === 'prev_tmux_pane_id')
  return col && { type: col.type, notnull: col.notnull }
}

describe('agents prev_tmux_pane_id column', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  it('a fresh database carries the nullable column', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    expect(prevPaneColumn(db)).toEqual({ type: 'TEXT', notnull: 0 })
    db.close()
  })

  it('adds the column to an existing database without touching its rows', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    createPrePaneMemoryAgents(db)
    db.prepare(
      `INSERT INTO agents
         (agent_id, device, team, role, name, registered_at, last_seen_at,
          tmux_pane_id, runtime_ui_pid, identity_key)
       VALUES ('a1', 'local', 'aoe', 'worker', 'alice', ?, ?, '%74', 9739, 'K1')`
    ).run('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

    applySchema(db, { localDevice: 'local' })

    expect(prevPaneColumn(db)).toEqual({ type: 'TEXT', notnull: 0 })
    const row = db.prepare(
      `SELECT tmux_pane_id, runtime_ui_pid, identity_key, prev_tmux_pane_id
       FROM agents WHERE agent_id='a1'`
    ).get()
    expect(row).toEqual({
      tmux_pane_id: '%74',
      runtime_ui_pid: 9739,
      identity_key: 'K1',
      // A row that predates the column has never had a pane taken from it.
      prev_tmux_pane_id: null,
    })
    db.close()
  })

  it('is idempotent on a second startup against the same database', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    createPrePaneMemoryAgents(db)
    applySchema(db, { localDevice: 'local' })

    let altered = 0
    const originalExec = db.exec.bind(db)
    db.exec = ((sql: string) => {
      if (/ADD COLUMN prev_tmux_pane_id/i.test(sql)) altered += 1
      return originalExec(sql)
    }) as typeof db.exec

    expect(() => applySchema(db, { localDevice: 'local' })).not.toThrow()
    expect(altered).toBe(0)
    db.close()
  })
})
