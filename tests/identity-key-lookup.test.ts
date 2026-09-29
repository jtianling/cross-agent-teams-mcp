import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { buildServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { IdentityKeyLookup } from '../src/mcp/identity-key-lookup.js'

vi.mock('../src/daemon/tmux-pane-list.js', () => ({
  listTmuxPaneIds: async () => new Set<string>(),
}))

const KEY = '808b3f15-6125-4581-99c3-761da5088484'
const URL = '/api/identity-key/lookup'

describe('identity key holder lookup HTTP contract', () => {
  let dir: string
  let app: Awaited<ReturnType<typeof buildServer>>
  let db: Database.Database
  let repo: AgentsRepo

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xats-ikl-'))
    const dbPath = join(dir, 'data.db')
    app = await buildServer({ dbPath, localDevice: 'local' })
    db = openDb(dbPath)
    repo = new AgentsRepo(db)
  })

  afterEach(async () => {
    await app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: URL, payload })

  function seed(name: string, team: string, device = 'local'): string {
    const { agent_id } = repo.register({ agent_type: 'custom', name, team, device })
    repo.bindIdentityKey(agent_id, KEY)
    return agent_id
  }

  it('returns not_found when no row holds the key', async () => {
    const response = await post({ protocol_version: 1, identity_key: KEY })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: false, error: 'not_found' })
  })

  it('reports the active holder', async () => {
    seed('mie-main', 'mie')
    const response = await post({ protocol_version: 1, identity_key: KEY })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      protocol_version: 1,
      identity_key: KEY,
      holder: { team: 'mie', name: 'mie-main', agent_type: 'custom', active: true },
    })
  })

  it('reports an inactive holder instead of hiding it', async () => {
    const id = seed('codex', 'mie')
    db.prepare(`UPDATE agents SET last_seen_at = ? WHERE agent_id = ?`)
      .run('2020-01-01T00:00:00.000Z', id)
    const response = await post({ protocol_version: 1, identity_key: KEY })
    expect(response.json()).toMatchObject({
      ok: true, holder: { team: 'mie', name: 'codex', active: false },
    })
  })

  it('ignores a holder on another device', async () => {
    seed('mie-main', 'mie', 'other-host')
    const response = await post({ protocol_version: 1, identity_key: KEY })
    expect(response.json()).toEqual({ ok: false, error: 'not_found' })
  })

  it.each([
    { protocol_version: 2, identity_key: KEY },
    { protocol_version: 1, identity_key: '' },
    { protocol_version: 1, identity_key: 'x'.repeat(257) },
    { protocol_version: 1, identity_key: KEY, team: 'mie' },
    { identity_key: KEY },
  ])('rejects invalid input: %j', async payload => {
    const lookup = vi.spyOn(IdentityKeyLookup.prototype, 'lookup')
    const response = await post(payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      ok: false, error: 'invalid_request', detail: 'Invalid identity key lookup',
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    { error: { code: 'SQLITE_BUSY' }, status: 503, message: 'storage_unavailable' },
    { error: new Error('private detail'), status: 500, message: 'internal_error' },
  ])('sanitizes failures: $message', async ({ error, status, message }) => {
    vi.spyOn(IdentityKeyLookup.prototype, 'lookup').mockRejectedValue(error)
    const response = await post({ protocol_version: 1, identity_key: KEY })
    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual({ ok: false, error: message })
  })

  it('rejects non-loopback access before lookup', async () => {
    const lookup = vi.spyOn(IdentityKeyLookup.prototype, 'lookup')
    const response = await app.inject({
      method: 'POST', url: URL,
      payload: { protocol_version: 1, identity_key: KEY },
      remoteAddress: '203.0.113.1',
    })
    expect(response.statusCode).toBe(403)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('requires configured bearer authentication', async () => {
    await app.close()
    app = await buildServer({ dbPath: ':memory:', token: 'test-only' })
    const response = await post({ protocol_version: 1, identity_key: KEY })
    expect(response.statusCode).toBe(401)
  })
})
