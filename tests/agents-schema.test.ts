import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function tableExists(db: ReturnType<typeof openDb>, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name) as { name: string } | undefined
  return row !== undefined
}

describe('agents schema', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('creates agents table with required columns and name is NOT NULL', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string; notnull: number; pk: number }>
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual([
      'agent_id', 'agent_type', 'agent_type_name', 'channel_session_id',
      'claude_ui_pid', 'delivery_kind', 'delivery_payload', 'device',
      'identity_key', 'last_processed_event_id', 'last_seen_at', 'model',
      'name', 'opencode_runtime_generation', 'prev_tmux_pane_id',
      'register_generation', 'registered_at', 'remote_addr', 'role',
      'runtime_bound_at', 'runtime_tty', 'runtime_ui_pid',
      'runtime_verification_mode', 'team', 'tmux_pane_id',
    ])
    const pk = cols.find(c => c.name === 'agent_id')
    expect(pk?.pk).toBe(1)
    const nameCol = cols.find(c => c.name === 'name')
    expect(nameCol?.type).toBe('TEXT')
    expect(nameCol?.notnull).toBe(1)
    const deviceCol = cols.find(c => c.name === 'device')
    expect(deviceCol?.type).toBe('TEXT')
    expect(deviceCol?.notnull).toBe(1)
    const pane = cols.find(c => c.name === 'tmux_pane_id')
    expect(pane?.type).toBe('TEXT')
    expect(pane?.notnull).toBe(0)
    db.close()
  })

  it('creates agents table with delivery_kind and delivery_payload columns', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    const deliveryKind = cols.find(c => c.name === 'delivery_kind')
    expect(deliveryKind).toBeDefined()
    expect(deliveryKind?.type).toBe('TEXT')
    expect(deliveryKind?.notnull).toBe(1)
    expect(deliveryKind?.dflt_value).toBe("'none'")
    const deliveryPayload = cols.find(c => c.name === 'delivery_payload')
    expect(deliveryPayload).toBeDefined()
    expect(deliveryPayload?.type).toBe('TEXT')
    expect(deliveryPayload?.notnull).toBe(0)
    const channel = cols.find(c => c.name === 'channel_session_id')
    expect(channel).toBeDefined()
    db.close()
  })

  it('fresh-db insert without delivery fields defaults delivery_kind=none and delivery_payload NULL', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    db.prepare(`INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('a1', 'local', 'default', 'impl', 'alice', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    const row = db.prepare(`SELECT delivery_kind, delivery_payload FROM agents WHERE agent_id = ?`).get('a1') as { delivery_kind: string; delivery_payload: string | null }
    expect(row.delivery_kind).toBe('none')
    expect(row.delivery_payload).toBeNull()
    db.close()
  })

  it('fresh-db channel_session_id column has type TEXT, notnull=0, and defaults NULL on insert', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    const channel = cols.find(c => c.name === 'channel_session_id')
    expect(channel).toBeDefined()
    expect(channel?.type).toBe('TEXT')
    expect(channel?.notnull).toBe(0)
    db.prepare(`INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('a2', 'local', 'default', 'impl', 'bob', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id = ?`).get('a2') as { channel_session_id: string | null }
    expect(row.channel_session_id).toBeNull()
    db.close()
  })

  it('creates UNIQUE agents_identity_idx covering (device, team, name)', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const indexes = db.pragma('index_list(agents)') as Array<{ name: string; unique: number }>
    const target = indexes.find(i => i.name === 'agents_identity_idx')
    expect(target).toBeDefined()
    expect(target?.unique).toBe(1)
    const info = db.pragma(`index_info(agents_identity_idx)`) as Array<{ seqno: number; name: string }>
    const ordered = info.sort((a, b) => a.seqno - b.seqno).map(i => i.name)
    expect(ordered).toEqual(['device', 'team', 'name'])
    db.close()
  })

  it('fresh install does not create legacy task or contract tables', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    expect(tableExists(db, 'tasks')).toBe(false)
    expect(tableExists(db, 'contracts')).toBe(false)
    expect(tableExists(db, 'contract_subscriptions')).toBe(false)
    db.close()
  })

  it('upgrade from prior version drops legacy task and contract tables', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        team TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        format TEXT NOT NULL,
        schema TEXT NOT NULL,
        registered_by TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );
      CREATE TABLE contract_subscriptions (
        agent_id TEXT NOT NULL,
        team TEXT NOT NULL,
        contract_name TEXT NOT NULL,
        subscribed_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, team, contract_name)
      );
      INSERT INTO tasks (id, team, title, status, depends_on, created_at)
      VALUES ('t1', 'default', 'legacy', 'pending', '[]', '2026-01-01T00:00:00Z');
      INSERT INTO contracts (team, name, version, format, schema, registered_by, registered_at)
      VALUES ('default', 'X', 1, 'jsonschema', '{}', 'a1', '2026-01-01T00:00:00Z');
      INSERT INTO contract_subscriptions (agent_id, team, contract_name, subscribed_at)
      VALUES ('a1', 'default', 'X', '2026-01-01T00:00:00Z');
    `)
    applySchema(db)
    expect(tableExists(db, 'tasks')).toBe(false)
    expect(tableExists(db, 'contracts')).toBe(false)
    expect(tableExists(db, 'contract_subscriptions')).toBe(false)
    db.close()
  })
})
