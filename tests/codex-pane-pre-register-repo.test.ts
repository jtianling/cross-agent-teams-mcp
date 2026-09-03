import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-prereg-repo-'))

describe('CodexPanePreRegRepo identity_key', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('stores identity_key and returns it from listUnexpired', () => {
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const rows = repo.listUnexpired('2026-01-01T00:00:00Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
  })

  it('stores NULL when no identity_key is supplied', () => {
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    expect(repo.getByPaneId('%10')?.identity_key).toBeNull()
  })

  it('same-pane overwrite without a key clears the stored key', () => {
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'A',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'B',
      expires_at: '2999-01-02T00:00:00Z',
    })
    const row = repo.getByPaneId('%10')
    expect(row).toEqual({
      pane_id: '%10',
      xats_agent_id: 'B',
      identity_key: null,
      expires_at: '2999-01-02T00:00:00Z',
    })
  })

  it('same-pane overwrite replaces an old key with the new one', () => {
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'A',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'B',
      identity_key: 'K2',
      expires_at: '2999-01-02T00:00:00Z',
    })
    expect(repo.getByPaneId('%10')?.identity_key).toBe('K2')
  })

  it('takeByPaneId returns the identity_key and consumes the row', () => {
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const taken = repo.takeByPaneId('%10')
    expect(taken).toEqual({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    expect(repo.getByPaneId('%10')).toBeUndefined()
  })

  it('getByPaneId reads without consuming', () => {
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    expect(repo.getByPaneId('%10')?.xats_agent_id).toBe('U1')
    expect(repo.getByPaneId('%10')).toBeDefined()
  })

  it('takeMatching consumes only on a full snapshot match', () => {
    const snapshot = {
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    }
    repo.upsert(snapshot)
    expect(repo.takeMatching(snapshot)).toEqual(snapshot)
    expect(repo.getByPaneId('%10')).toBeUndefined()
  })

  it('takeMatching matches rows whose identity_key is NULL', () => {
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const taken = repo.takeMatching({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: null,
      expires_at: '2999-01-01T00:00:00Z',
    })
    expect(taken?.identity_key).toBeNull()
    expect(repo.getByPaneId('%10')).toBeUndefined()
  })

  it('takeMatching leaves an overwritten row untouched', () => {
    const original = {
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    }
    repo.upsert(original)
    // Overwrite: new uuid and key.
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U9',
      identity_key: 'K9',
      expires_at: '2999-02-01T00:00:00Z',
    })
    expect(repo.takeMatching(original)).toBeUndefined()
    expect(repo.getByPaneId('%10')).toMatchObject({
      xats_agent_id: 'U9',
      identity_key: 'K9',
    })
  })

  it('takeMatching treats a same-value expiry refresh as a different row', () => {
    const original = {
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    }
    repo.upsert(original)
    repo.upsert({ ...original, expires_at: '2999-06-01T00:00:00Z' })
    expect(repo.takeMatching(original)).toBeUndefined()
    expect(repo.getByPaneId('%10')?.expires_at).toBe('2999-06-01T00:00:00Z')
  })

  it('migration drops team and agent_name and is idempotent', () => {
    const dir = tmp()
    cleanups.push(dir)
    const legacy = openDb(join(dir, 'legacy.db'))
    legacy.exec(`CREATE TABLE codex_pane_pre_registrations (
      pane_id TEXT PRIMARY KEY,
      xats_agent_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      identity_key TEXT,
      team TEXT,
      agent_name TEXT
    )`)
    legacy.prepare(
      `INSERT INTO codex_pane_pre_registrations
         (pane_id, xats_agent_id, expires_at, identity_key, team, agent_name)
       VALUES ('%25', 'U1', '2999-01-01T00:00:00Z', 'K1', 'monkeys', 'coder')`
    ).run()

    applySchema(legacy, { localDevice: 'local' })
    const columnNames = (): string[] => (
      legacy.pragma('table_info(codex_pane_pre_registrations)') as Array<{
        name: string
      }>
    ).map(c => c.name)
    expect(columnNames()).not.toContain('team')
    expect(columnNames()).not.toContain('agent_name')
    expect(new CodexPanePreRegRepo(legacy).getByPaneId('%25')).toEqual({
      pane_id: '%25',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })

    expect(() => applySchema(legacy, { localDevice: 'local' })).not.toThrow()
    expect(columnNames()).toEqual([
      'pane_id', 'xats_agent_id', 'expires_at', 'identity_key',
    ])
    legacy.close()
  })
})
