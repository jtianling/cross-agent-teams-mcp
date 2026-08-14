import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-prereg-key-'))

function createLegacyPreRegTable(db: Database.Database): void {
  db.exec(`CREATE TABLE codex_pane_pre_registrations (
    pane_id TEXT PRIMARY KEY,
    xats_agent_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`)
}

function createIdentityKeyPreRegTable(db: Database.Database): void {
  db.exec(`CREATE TABLE codex_pane_pre_registrations (
    pane_id TEXT PRIMARY KEY,
    xats_agent_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    identity_key TEXT
  )`)
}

function columnNames(db: Database.Database): string[] {
  const cols = db.pragma(
    'table_info(codex_pane_pre_registrations)'
  ) as Array<{ name: string }>
  return cols.map(c => c.name)
}

describe('codex_pane_pre_registrations optional columns', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  it('a fresh database carries all nullable optional columns', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma(
      'table_info(codex_pane_pre_registrations)'
    ) as Array<{ name: string; type: string; notnull: number }>
    for (const name of ['identity_key', 'team', 'agent_name']) {
      const col = cols.find(c => c.name === name)
      expect(col).toBeDefined()
      expect(col?.type).toBe('TEXT')
      expect(col?.notnull).toBe(0)
    }
    db.close()
  })

  it('heals a legacy database and leaves pre-existing rows at NULL', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    createLegacyPreRegTable(db)
    db.prepare(
      `INSERT INTO codex_pane_pre_registrations (pane_id, xats_agent_id, expires_at)
       VALUES ('%10', 'U1', '2999-01-01T00:00:00Z')`
    ).run()

    applySchema(db, { localDevice: 'local' })

    expect(columnNames(db)).toEqual(expect.arrayContaining([
      'identity_key', 'team', 'agent_name',
    ]))
    const row = db.prepare(
      `SELECT identity_key, team, agent_name
       FROM codex_pane_pre_registrations WHERE pane_id='%10'`
    ).get() as Record<string, string | null>
    expect(row).toEqual({ identity_key: null, team: null, agent_name: null })
    db.close()
  })

  it('heals the production shape that already carries identity_key', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    createIdentityKeyPreRegTable(db)
    db.prepare(
      `INSERT INTO codex_pane_pre_registrations
         (pane_id, xats_agent_id, expires_at, identity_key)
       VALUES ('%10', 'U1', '2999-01-01T00:00:00Z', 'K1')`
    ).run()

    applySchema(db, { localDevice: 'local' })

    expect(columnNames(db)).toEqual(expect.arrayContaining([
      'identity_key', 'team', 'agent_name',
    ]))
    const row = db.prepare(
      `SELECT identity_key, team, agent_name
       FROM codex_pane_pre_registrations WHERE pane_id='%10'`
    ).get()
    expect(row).toEqual({ identity_key: 'K1', team: null, agent_name: null })
    db.close()
  })

  it('is idempotent on a second startup against the same database', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    createLegacyPreRegTable(db)
    applySchema(db, { localDevice: 'local' })

    let altered = 0
    const originalExec = db.exec.bind(db)
    db.exec = ((sql: string) => {
      if (/codex_pane_pre_registrations ADD COLUMN/i.test(sql)) {
        altered += 1
      }
      return originalExec(sql)
    }) as typeof db.exec

    expect(() => applySchema(db, { localDevice: 'local' })).not.toThrow()
    expect(altered).toBe(0)
    db.close()
  })
})

describe('agents register_generation column', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  function generationColumn(
    db: Database.Database
  ): { name: string; type: string; notnull: number; dflt_value: string } | undefined {
    const cols = db.pragma('table_info(agents)') as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string
    }>
    return cols.find(c => c.name === 'register_generation')
  }

  it('a fresh database carries register_generation NOT NULL DEFAULT 0', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const col = generationColumn(db)
    expect(col).toBeDefined()
    expect(col?.type).toBe('INTEGER')
    expect(col?.notnull).toBe(1)
    expect(col?.dflt_value).toBe('0')
    db.close()
  })

  it('heals a legacy database and leaves pre-existing rows at 0', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db, { localDevice: 'local' })
    // Simulate a pre-change database: the column did not exist yet.
    db.exec(`ALTER TABLE agents DROP COLUMN register_generation`)
    db.prepare(
      `INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at)
       VALUES ('a1', 'local', 'default', 'default', 'alice', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    ).run()

    applySchema(db, { localDevice: 'local' })

    expect(generationColumn(db)).toBeDefined()
    const row = db.prepare(
      `SELECT register_generation FROM agents WHERE agent_id='a1'`
    ).get() as { register_generation: number }
    expect(row.register_generation).toBe(0)
    db.close()
  })

  it('is idempotent on a second startup against the same database', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db, { localDevice: 'local' })
    db.exec(`ALTER TABLE agents DROP COLUMN register_generation`)
    applySchema(db, { localDevice: 'local' })

    let altered = 0
    const originalExec = db.exec.bind(db)
    db.exec = ((sql: string) => {
      if (/agents ADD COLUMN register_generation/i.test(sql)) {
        altered += 1
      }
      return originalExec(sql)
    }) as typeof db.exec

    expect(() => applySchema(db, { localDevice: 'local' })).not.toThrow()
    expect(altered).toBe(0)
    db.close()
  })
})
