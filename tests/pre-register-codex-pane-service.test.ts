import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import { PreRegisterCodexPaneService } from '../src/mcp/pre-register-codex-pane.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-pre-reg-'))

describe('PreRegisterCodexPaneService', () => {
  const cleanups: string[] = []
  let dbPath: string
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    dbPath = join(dir, 'data.db')
    db = openDb(dbPath)
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('persists a pre-reg with default 120s TTL', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, { now: () => fixed })
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1' })
    expect(res).toEqual({
      ok: true,
      expires_at: '2026-01-01T00:02:00.000Z',
      received_fields: ['pane_id', 'xats_agent_id'],
      pane_visible: 'unknown',
    })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pane_id: '%10', xats_agent_id: 'U1' })
  })

  it('clamps ttl_seconds above 600 to 600', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, { now: () => fixed })
    const res = svc.register({ pane_id: '%11', xats_agent_id: 'U2', ttl_seconds: 9999 })
    expect(res).toEqual({
      ok: true,
      expires_at: '2026-01-01T00:10:00.000Z',
      received_fields: ['pane_id', 'xats_agent_id', 'ttl_seconds'],
      pane_visible: 'unknown',
    })
  })

  it('rejects missing pane_id', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ xats_agent_id: 'U1' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/pane_id/i)
    expect(repo.listUnexpired(new Date().toISOString())).toHaveLength(0)
  })

  it('rejects empty xats_agent_id', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '%10', xats_agent_id: '' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/xats_agent_id/i)
  })

  it('rejects pane_id not starting with %', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '1972', xats_agent_id: 'U1' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/pane_id/i)
  })

  it('rejects non-positive ttl_seconds', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1', ttl_seconds: 0 })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
  })

  it('overwrites existing pre-reg for same pane', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, { now: () => fixed })
    svc.register({ pane_id: '%10', xats_agent_id: 'A' })
    svc.register({ pane_id: '%10', xats_agent_id: 'B' })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0].xats_agent_id).toBe('B')
  })

  it('stores identity_key when supplied', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, { now: () => fixed })
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1', identity_key: 'K1' })
    expect(res).toEqual({
      ok: true,
      expires_at: '2026-01-01T00:02:00.000Z',
      received_fields: ['pane_id', 'xats_agent_id', 'identity_key'],
      pane_visible: 'unknown',
    })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows[0].identity_key).toBe('K1')
  })

  it('stores NULL identity_key when omitted', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    svc.register({ pane_id: '%10', xats_agent_id: 'U1' })
    expect(repo.getByPaneId('%10')?.identity_key).toBeNull()
  })

  it('rejects an empty identity_key without writing state', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1', identity_key: '' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/identity_key/i)
    expect(repo.listUnexpired(new Date().toISOString())).toHaveLength(0)
  })

  it('rejects a whitespace-only identity_key without writing state', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1', identity_key: '   ' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/identity_key/i)
    expect(repo.listUnexpired(new Date().toISOString())).toHaveLength(0)
  })

  it('overwrite without identity_key clears the stored key once the carrier is gone', () => {
    // The probe is injected rather than defaulted: the real one shells out to
    // tmux, and a unit test must never reach the machine's tmux server.  Gone
    // carrier is also the case this assertion has always been about — a live
    // one now refuses the overwrite, covered separately.
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, {
      now: () => fixed,
      carrierAlive: () => false,
    })
    svc.register({ pane_id: '%10', xats_agent_id: 'A', identity_key: 'K1' })
    svc.register({ pane_id: '%10', xats_agent_id: 'B' })
    const row = repo.getByPaneId('%10')
    expect(row?.xats_agent_id).toBe('B')
    expect(row?.identity_key).toBeNull()
  })

  it('fires onAccepted with the accepted row, and never on rejection', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const accepted: unknown[] = []
    const svc = new PreRegisterCodexPaneService(repo, {
      now: () => fixed,
      onAccepted: row => { accepted.push(row) },
      carrierAlive: () => false,
    })
    svc.register({ pane_id: '%10', xats_agent_id: 'U1', identity_key: 'K1' })
    svc.register({ pane_id: '%10', xats_agent_id: 'U2' })
    svc.register({ pane_id: '%11', xats_agent_id: '' })
    expect(accepted).toEqual([
      {
        pane_id: '%10',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        team: null,
        agent_name: null,
        expires_at: '2026-01-01T00:02:00.000Z',
      },
      {
        pane_id: '%10',
        xats_agent_id: 'U2',
        identity_key: null,
        team: null,
        agent_name: null,
        expires_at: '2026-01-01T00:02:00.000Z',
      },
    ])
  })

  it('an onAccepted failure does not corrupt the ok envelope, and is logged', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const logged: string[] = []
    const svc = new PreRegisterCodexPaneService(repo, {
      now: () => fixed,
      onAccepted: () => { throw new Error('boom') },
      log: line => { logged.push(line) },
    })
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1', identity_key: 'K1' })
    expect(res).toMatchObject({ ok: true, expires_at: '2026-01-01T00:02:00.000Z' })
    expect(repo.getByPaneId('%10')?.identity_key).toBe('K1')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('stage=onAccepted')
    expect(logged[0]).toContain('%10')
    expect(logged[0]).toContain('boom')
    expect(logged[0]).not.toContain('K1')
  })

  it('an onAccepted error embedding the key value is redacted in the log', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const logged: string[] = []
    const svc = new PreRegisterCodexPaneService(repo, {
      now: () => fixed,
      onAccepted: () => { throw new Error('lookup failed for K1') },
      log: line => { logged.push(line) },
    })
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1', identity_key: 'K1' })
    expect(res).toMatchObject({ ok: true, expires_at: '2026-01-01T00:02:00.000Z' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('Error')
    expect(logged[0]).toContain('[redacted]')
    expect(logged[0]).not.toContain('K1')
  })

  it('deleteExpired runs on write and removes stale rows', () => {
    let t = new Date('2026-01-01T00:00:00.000Z').getTime()
    const svc = new PreRegisterCodexPaneService(repo, { now: () => new Date(t) })
    svc.register({ pane_id: '%OLD', xats_agent_id: 'X', ttl_seconds: 1 })
    // jump forward past expiry
    t += 5_000
    svc.register({ pane_id: '%NEW', xats_agent_id: 'Y' })
    const rows = repo.listUnexpired(new Date(t).toISOString())
    expect(rows.map(r => r.pane_id).sort()).toEqual(['%NEW'])
  })

  // Measured 2026-08-01: a lab fixture on a private tmux socket wrote its rows
  // into the production database, got {"ok":true}, and neither side had any
  // signal — the rows were found from the other end days later.
  describe('the response reports what it received and what the daemon can see', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')

    it('names the fields received, and carries no value of any of them', () => {
      const svc = new PreRegisterCodexPaneService(repo, { now: () => fixed })
      const res = svc.register({
        pane_id: '%10', xats_agent_id: 'U1', identity_key: 'K1',
      })
      expect(res).toMatchObject({
        ok: true,
        received_fields: ['pane_id', 'xats_agent_id', 'identity_key'],
      })
      expect(JSON.stringify(res)).not.toContain('K1')
    })

    it('reports an omitted optional as not received', () => {
      const svc = new PreRegisterCodexPaneService(repo, { now: () => fixed })
      const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1' })
      expect(res).toMatchObject({
        ok: true, received_fields: ['pane_id', 'xats_agent_id'],
      })
    })

    it('reports a pane the daemon cannot see, and writes the row anyway', () => {
      // Reported, never enforced: refusing here would gate the write on the
      // daemon's own tmux resolution, which is the thing misconfigured in the
      // case this exists to detect.
      const svc = new PreRegisterCodexPaneService(repo, {
        now: () => fixed,
        paneVisible: () => false,
      })
      const res = svc.register({
        pane_id: '%0', xats_agent_id: 'U1', identity_key: 'K1',
      })
      expect(res).toMatchObject({ ok: true, pane_visible: false })
      expect(repo.getByPaneId('%0')).toMatchObject({
        xats_agent_id: 'U1', identity_key: 'K1',
      })
    })

    it('reports a visible pane as visible', () => {
      const svc = new PreRegisterCodexPaneService(repo, {
        now: () => fixed,
        paneVisible: () => true,
      })
      expect(svc.register({ pane_id: '%0', xats_agent_id: 'U1' }))
        .toMatchObject({ ok: true, pane_visible: true })
    })

    it('a throwing probe reports unknown and the call still succeeds', () => {
      const svc = new PreRegisterCodexPaneService(repo, {
        now: () => fixed,
        paneVisible: () => { throw new Error('no server running') },
      })
      const res = svc.register({ pane_id: '%0', xats_agent_id: 'U1' })
      expect(res).toMatchObject({ ok: true, pane_visible: 'unknown' })
      expect(repo.getByPaneId('%0')?.xats_agent_id).toBe('U1')
    })

    it('an unconfigured probe reports unknown rather than not-visible', () => {
      const svc = new PreRegisterCodexPaneService(repo, { now: () => fixed })
      expect(svc.register({ pane_id: '%0', xats_agent_id: 'U1' }))
        .toMatchObject({ ok: true, pane_visible: 'unknown' })
    })
  })

  // S9: measured, a stranger overwriting another pane's row destroyed the
  // victim's identity_key, made the victim fail to bind against the stranger's
  // uuid, and blocked the victim's own pane for the stranger's chosen TTL —
  // while the victim's register_agent still returned success.
  describe('a live keyed row is only replaceable by something holding its key', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    function svcWith(alive: boolean): PreRegisterCodexPaneService {
      return new PreRegisterCodexPaneService(repo, {
        now: () => fixed,
        carrierAlive: () => alive,
      })
    }
    function seedVictim(): void {
      new PreRegisterCodexPaneService(repo, {
        now: () => fixed,
        carrierAlive: () => false,
      }).register({ pane_id: '%10', xats_agent_id: 'U_VICTIM', identity_key: 'K_V' })
    }

    it('refuses a keyless overwrite and leaves the row untouched', () => {
      seedVictim()
      const res = svcWith(true).register({ pane_id: '%10', xats_agent_id: 'U_X' })
      expect(res).toMatchObject({ error: 'pane_claimed' })
      const row = repo.getByPaneId('%10')
      expect(row?.xats_agent_id).toBe('U_VICTIM')
      expect(row?.identity_key).toBe('K_V')
    })

    it('refuses an overwrite carrying a DIFFERENT key', () => {
      // Holding *a* key is not the credential: a different one overwrote just
      // as freely, and keys do leak through the shared app-server environment.
      seedVictim()
      const res = svcWith(true).register({
        pane_id: '%10', xats_agent_id: 'U_X', identity_key: 'K_OTHER',
      })
      expect(res).toMatchObject({ error: 'pane_claimed' })
      expect(repo.getByPaneId('%10')?.identity_key).toBe('K_V')
    })

    it('accepts the rightful launcher re-announcing with the same key', () => {
      seedVictim()
      const res = svcWith(true).register({
        pane_id: '%10', xats_agent_id: 'U_NEW', identity_key: 'K_V',
      })
      expect(res).toMatchObject({ ok: true })
      expect(repo.getByPaneId('%10')?.xats_agent_id).toBe('U_NEW')
    })

    it('stops protecting once the row\'s own carrier is gone', () => {
      // A tmux server restart reissues pane ids from %0 while old rows linger
      // for their TTL; protecting them would refuse a whole batch of legitimate
      // relaunches right after an incident.
      seedVictim()
      const res = svcWith(false).register({ pane_id: '%10', xats_agent_id: 'U_X' })
      expect(res).toMatchObject({ ok: true })
      expect(repo.getByPaneId('%10')?.xats_agent_id).toBe('U_X')
    })

    it('does not protect a keyless row, nor consult the probe for one', () => {
      let probed = 0
      new PreRegisterCodexPaneService(repo, {
        now: () => fixed,
        carrierAlive: () => false,
      }).register({ pane_id: '%10', xats_agent_id: 'U_A' })
      const svc = new PreRegisterCodexPaneService(repo, {
        now: () => fixed,
        carrierAlive: () => { probed += 1; return true },
      })
      expect(svc.register({ pane_id: '%10', xats_agent_id: 'U_B' })).toMatchObject({ ok: true })
      expect(probed).toBe(0)
    })

    it('does not protect an expired row', () => {
      seedVictim()
      const later = new Date('2026-01-01T01:00:00.000Z')
      const svc = new PreRegisterCodexPaneService(repo, {
        now: () => later,
        carrierAlive: () => true,
      })
      expect(svc.register({ pane_id: '%10', xats_agent_id: 'U_X' })).toMatchObject({ ok: true })
    })
  })
})
