import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDeliveryRow, serializeDelivery } from '../src/lib/delivery-spec.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-opencode-runtime-'))

describe('OpenCode runtime storage', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('creates and migrates the independent runtime fence at baseline zero', () => {
    const dir = tmp()
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db, { localDevice: 'local' })
    db.exec(`ALTER TABLE agents DROP COLUMN opencode_runtime_generation`)
    db.prepare(
      `INSERT INTO agents (
         agent_id, device, team, role, name, registered_at, last_seen_at
       ) VALUES (
         'a1', 'local', 'dev', 'worker', 'open',
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
       )`
    ).run()

    applySchema(db, { localDevice: 'local' })

    const column = (db.pragma('table_info(agents)') as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string
    }>).find(row => row.name === 'opencode_runtime_generation')
    expect(column).toMatchObject({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    })
    const row = db.prepare(
      `SELECT opencode_runtime_generation FROM agents WHERE agent_id = 'a1'`
    ).get() as { opencode_runtime_generation: number }
    expect(row.opencode_runtime_generation).toBe(0)
    db.close()
  })

  it('reads legacy delivery at zero and round-trips a committed generation', () => {
    const legacy = parseDeliveryRow({
      delivery_kind: 'opencode-server',
      delivery_payload: JSON.stringify({
        session_id: 'ses_legacy',
        base_url: 'http://127.0.0.1:3000',
        auth_token_ref: 'OPENCODE_PASSWORD',
      }),
    })
    expect(legacy).toEqual({
      kind: 'opencode-server',
      session_id: 'ses_legacy',
      base_url: 'http://127.0.0.1:3000',
      auth_token_ref: 'OPENCODE_PASSWORD',
    })
    expect(Object.hasOwn(legacy, 'runtime_generation')).toBe(false)
    if (legacy.kind === 'opencode-server') {
      expect(legacy.runtime_generation ?? 0).toBe(0)
    }

    const committed = {
      kind: 'opencode-server' as const,
      session_id: 'ses_current',
      base_url: 'http://127.0.0.1:3001',
      auth_token_ref: 'OPENCODE_PASSWORD',
      runtime_generation: 7,
    }
    expect(parseDeliveryRow(serializeDelivery(committed))).toEqual(committed)
  })

  it('reserve and commit CAS preserve identity, auth, cursor, and '
    + 'register generation', () => {
    const dir = tmp()
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db, { localDevice: 'local' })
    const repo = new AgentsRepo(db)
    const registered = repo.register({
      agent_type: 'opencode',
      name: 'open',
      team: 'dev',
      role: 'worker',
      model: 'model-a',
      identity_key: 'key-a',
      opencode_runtime_generation: 4,
      delivery: {
        kind: 'opencode-server',
        session_id: 'ses_old',
        base_url: 'http://127.0.0.1:3000',
        auth_token_ref: 'OPENCODE_PASSWORD',
        runtime_generation: 4,
      },
    })
    db.prepare(
      `UPDATE agents SET last_processed_event_id = 41 WHERE agent_id = ?`
    ).run(registered.agent_id)
    const before = repo.findOpencodeRuntimeByIdentityKey('key-a', 'local')!

    expect(repo.compareAndSetOpencodeRuntimeGeneration({
      agent_id: before.agent_id,
      device: before.device,
      identity_key: 'key-a',
      expected_generation: 4,
      expected_register_generation: before.register_generation,
      runtime_generation: 5,
    }).changes).toBe(1)
    const reserved = repo.findOpencodeRuntimeByIdentityKey('key-a', 'local')!
    expect(repo.compareAndSetOpencodeDelivery({
      agent_id: reserved.agent_id,
      device: reserved.device,
      identity_key: 'key-a',
      expected_generation: 5,
      expected_register_generation: reserved.register_generation,
      expected_delivery_kind: reserved.delivery_kind,
      expected_delivery_payload: reserved.delivery_payload,
      delivery: {
        kind: 'opencode-server',
        session_id: 'ses_new',
        base_url: 'http://127.0.0.1:3001',
        auth_token_ref: 'OPENCODE_PASSWORD',
        runtime_generation: 5,
      },
    }).changes).toBe(1)

    const after = repo.findOpencodeRuntimeByIdentityKey('key-a', 'local')!
    expect(after).toMatchObject({
      agent_id: before.agent_id,
      agent_type: before.agent_type,
      name: before.name,
      team: before.team,
      role: before.role,
      model: before.model,
      registered_at: before.registered_at,
      last_processed_event_id: 41,
      identity_key: 'key-a',
      register_generation: before.register_generation,
      opencode_runtime_generation: 5,
      delivery: {
        kind: 'opencode-server',
        session_id: 'ses_new',
        auth_token_ref: 'OPENCODE_PASSWORD',
        runtime_generation: 5,
      },
    })
    db.close()
  })

  it('normalizes and reserves a nullable legacy fence through CAS', () => {
    const dir = tmp()
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db, { localDevice: 'local' })
    const originalRepo = new AgentsRepo(db)
    originalRepo.register({
      agent_type: 'opencode',
      name: 'legacy-null',
      team: 'dev',
      identity_key: 'legacy-null-key',
      delivery: {
        kind: 'opencode-server',
        session_id: 'ses_legacy',
        base_url: 'http://127.0.0.1:3000',
      },
    })
    db.exec(`CREATE TABLE agents_legacy AS SELECT * FROM agents`)
    db.exec(`DROP TABLE agents`)
    db.exec(`ALTER TABLE agents_legacy RENAME TO agents`)
    db.exec(
      `UPDATE agents
       SET opencode_runtime_generation = NULL
       WHERE identity_key = 'legacy-null-key'`
    )

    const repo = new AgentsRepo(db)
    const before = repo.findOpencodeRuntimeByIdentityKey(
      'legacy-null-key',
      'local'
    )!
    expect(before.opencode_runtime_generation).toBe(0)
    expect(repo.compareAndSetOpencodeRuntimeGeneration({
      agent_id: before.agent_id,
      device: before.device,
      identity_key: 'legacy-null-key',
      expected_generation: 0,
      expected_register_generation: before.register_generation,
      runtime_generation: 1,
    }).changes).toBe(1)

    db.exec(
      `UPDATE agents
       SET opencode_runtime_generation = NULL
       WHERE identity_key = 'legacy-null-key'`
    )
    applySchema(db, { localDevice: 'local' })
    const migrated = db.prepare(
      `SELECT opencode_runtime_generation
       FROM agents WHERE identity_key = 'legacy-null-key'`
    ).get() as { opencode_runtime_generation: number }
    expect(migrated.opencode_runtime_generation).toBe(0)
    db.close()
  })
})
