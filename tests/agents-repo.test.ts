import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('agents repo', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('register generates a fresh agent_id for a new identity', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    expect(typeof r.agent_id).toBe('string')
    expect(r.agent_id.length).toBeGreaterThan(0)
    expect(r.team).toBe('default')
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?').get(r.agent_id) as { role: string; team: string; name: string }
    expect(row.role).toBe('backend')
    expect(row.team).toBe('default')
    expect(row.name).toBe('alice')
    db.close()
  })

  it('repeated register for same identity reuses agent_id and upserts metadata', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r1 = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const r2 = repo.register({ model: 'sonnet', role: 'backend', name: 'alice' })
    expect(r2.agent_id).toBe(r1.agent_id)
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?').get(r1.agent_id) as { name: string; model: string }
    expect(row.name).toBe('alice')
    expect(row.model).toBe('sonnet')
    const count = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    expect(count.c).toBe(1)
    db.close()
  })

  it('register returns the row ACTUAL prior state from the upsert transaction', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const first = repo.register({
      name: 'codex-a',
      agent_type: 'codex',
      delivery: {
        kind: 'codex-appserver',
        thread_id: 'T1',
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    expect(first.prior_snapshot).toBeNull()
    db.prepare(
      `UPDATE agents SET runtime_ui_pid=?, runtime_tty=?, tmux_pane_id=?,
         runtime_bound_at=? WHERE agent_id=?`
    ).run(4242, 'ttys055', '%55', '2026-01-05T00:00:00Z', first.agent_id)

    const second = repo.register({
      name: 'codex-a',
      agent_type: 'codex',
      delivery: {
        kind: 'codex-appserver',
        thread_id: 'T2',
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    // The prior stored thread and the full physical seat, captured inside
    // the same transaction that overwrote the thread with T2.
    expect(second.prior_snapshot).toEqual({
      agent_id: first.agent_id,
      codex_thread_id: 'T1',
      runtime_ui_pid: 4242,
      runtime_tty: 'ttys055',
      tmux_pane_id: '%55',
      runtime_bound_at: '2026-01-05T00:00:00Z',
    })
    db.close()
  })

  it('register mints a per-row register_generation that every upsert increments', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r1 = repo.register({ name: 'alice' })
    expect(r1.register_generation).toBe(1)
    const r2 = repo.register({ name: 'alice' })
    expect(r2.agent_id).toBe(r1.agent_id)
    expect(r2.register_generation).toBe(2)
    // Another identity keeps its own counter.
    const other = repo.register({ name: 'bob' })
    expect(other.register_generation).toBe(1)
    db.close()
  })

  it('setRuntimeBinding with a stale register_generation changes zero rows and touches nothing', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const first = repo.register({ name: 'codex-a' })
    // A bystander row bound to the seat the stale write would claim: a
    // stale bind must not evict its pane either.
    const bystander = repo.register({ name: 'codex-b' })
    repo.setRuntimeBinding(bystander.agent_id, {
      tmux_pane_id: '%67',
      runtime_ui_pid: 101,
      runtime_tty: 'ttys010',
      runtime_verification_mode: 'verified_pid_tty_pane',
    })

    // The newer registration (generation 2) binds seat %20.
    const second = repo.register({ name: 'codex-a' })
    const fresh = repo.setRuntimeBinding(second.agent_id, {
      tmux_pane_id: '%20',
      runtime_ui_pid: 202,
      runtime_tty: 'ttys021',
      runtime_verification_mode: 'verified_pid_tty_pane',
      expected_register_generation: second.register_generation,
    })
    expect(fresh.changes).toBe(1)

    // The FIRST registration's late bind write carries the stale generation.
    const stale = repo.setRuntimeBinding(first.agent_id, {
      tmux_pane_id: '%67',
      runtime_ui_pid: 4242,
      runtime_tty: 'ttys010',
      runtime_verification_mode: 'verified_pid_tty_pane',
      expected_register_generation: first.register_generation,
    })
    expect(stale.changes).toBe(0)

    const row = db.prepare(
      `SELECT tmux_pane_id, runtime_ui_pid, runtime_tty FROM agents WHERE agent_id=?`
    ).get(first.agent_id) as {
      tmux_pane_id: string | null
      runtime_ui_pid: number | null
      runtime_tty: string | null
    }
    expect(row).toEqual({
      tmux_pane_id: '%20',
      runtime_ui_pid: 202,
      runtime_tty: 'ttys021',
    })
    // The bystander's pane binding survived: the stale write skipped the
    // incumbent-pane eviction along with the row write.
    const bystanderRow = db.prepare(
      `SELECT tmux_pane_id FROM agents WHERE agent_id=?`
    ).get(bystander.agent_id) as { tmux_pane_id: string | null }
    expect(bystanderRow.tmux_pane_id).toBe('%67')
    db.close()
  })

  it('setRuntimeBinding without an expected generation stays unconditional (repo primitive; service callers default to call-start capture)', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r = repo.register({ name: 'codex-a' })
    repo.register({ name: 'codex-a' })
    repo.register({ name: 'codex-a' })
    const written = repo.setRuntimeBinding(r.agent_id, {
      tmux_pane_id: '%5',
      runtime_ui_pid: 55,
      runtime_tty: 'ttys005',
      runtime_verification_mode: 'verified_pid_tty_pane',
    })
    expect(written.changes).toBe(1)
    const row = db.prepare(
      `SELECT tmux_pane_id FROM agents WHERE agent_id=?`
    ).get(r.agent_id) as { tmux_pane_id: string | null }
    expect(row.tmux_pane_id).toBe('%5')
    db.close()
  })

  it('clearRuntimeBinding wipes every runtime-seat field while the generation matches', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r = repo.register({ name: 'codex-a' })
    repo.setRuntimeBinding(r.agent_id, {
      tmux_pane_id: '%20',
      runtime_ui_pid: 202,
      runtime_tty: 'ttys021',
      runtime_verification_mode: 'verified_pid_tty_pane',
    })
    const cleared = repo.clearRuntimeBinding(r.agent_id, {
      expected_register_generation: r.register_generation,
    })
    expect(cleared.changes).toBe(1)
    const row = db.prepare(
      `SELECT tmux_pane_id, runtime_ui_pid, runtime_tty,
              runtime_verification_mode, runtime_bound_at
       FROM agents WHERE agent_id=?`
    ).get(r.agent_id)
    expect(row).toEqual({
      tmux_pane_id: null,
      runtime_ui_pid: null,
      runtime_tty: null,
      runtime_verification_mode: null,
      runtime_bound_at: null,
    })
    db.close()
  })

  it('clearRuntimeBinding with a stale generation changes nothing — a newer registration keeps its seat', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const first = repo.register({ name: 'codex-a' })
    const second = repo.register({ name: 'codex-a' })
    repo.setRuntimeBinding(first.agent_id, {
      tmux_pane_id: '%20',
      runtime_ui_pid: 202,
      runtime_tty: 'ttys021',
      runtime_verification_mode: 'verified_pid_tty_pane',
      expected_register_generation: second.register_generation,
    })
    const cleared = repo.clearRuntimeBinding(first.agent_id, {
      expected_register_generation: first.register_generation,
    })
    expect(cleared.changes).toBe(0)
    const row = db.prepare(
      `SELECT tmux_pane_id, runtime_ui_pid FROM agents WHERE agent_id=?`
    ).get(first.agent_id)
    expect(row).toEqual({ tmux_pane_id: '%20', runtime_ui_pid: 202 })
    db.close()
  })

  it('list_agents returns only caller team', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const a1 = repo.register({ model: 'm', role: 'r', name: 'a1', team: 'alpha' })
    const a2 = repo.register({ model: 'm', role: 'r', name: 'a2', team: 'alpha' })
    repo.register({ model: 'm', role: 'r', name: 'b1', team: 'beta' })
    const out = repo.list({ team: 'alpha' })
    expect(out.map(a => a.agent_id).sort()).toEqual([a1.agent_id, a2.agent_id].sort())
  })

  it('online flag uses the reachable fallback when process liveness is unavailable', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const fresh = repo.register({ model: 'm', role: 'r', name: 'fresh' })
    const stale = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    db.prepare(`INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at) VALUES (?,?,?,?,?,?,?)`)
      .run('stale', 'local', 'default', 'r', 'stale-name', stale, stale)
    const out = repo.list({ team: 'default' })
    const freshRow = out.find(a => a.agent_id === fresh.agent_id)!
    const staleRow = out.find(a => a.agent_id === 'stale')!
    expect(freshRow.online).toBe(true)
    expect(staleRow.online).toBe(false)
  })

  it('role change reuses agent_id and updates role in place (identity is device+team+name)', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r1 = repo.register({ model: 'm', role: 'backend', name: 'alice' })
    const r2 = repo.register({ model: 'm', role: 'frontend', name: 'alice' })
    expect(r2.agent_id).toBe(r1.agent_id)
    const count = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    expect(count.c).toBe(1)
    const row = db.prepare('SELECT role FROM agents WHERE agent_id=?').get(r1.agent_id) as { role: string }
    expect(row.role).toBe('frontend')
    db.close()
  })

  it('team change produces a new agent_id', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r1 = repo.register({ model: 'm', role: 'backend', name: 'alice' })
    const r2 = repo.register({ model: 'm', role: 'backend', name: 'alice', team: 'alpha' })
    expect(r2.agent_id).not.toBe(r1.agent_id)
    const count = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    expect(count.c).toBe(2)
    db.close()
  })

  it('findByIdentity returns existing agent_id or undefined', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    expect(repo.findByIdentity({ device: 'local', team: 'default', name: 'alice' })).toBeUndefined()
    const r = repo.register({ model: 'm', role: 'backend', name: 'alice' })
    expect(repo.findByIdentity({ device: 'local', team: 'default', name: 'alice' })).toEqual({ agent_id: r.agent_id })
  })
})

describe('AgentsRepo tmux_pane_id', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function freshRepo() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, repo: new AgentsRepo(db) }
  }

  it('persists tmux_pane_id when provided', () => {
    const { db, repo } = freshRepo()
    const r = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r.agent_id) as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%42')
    db.close()
  })

  it('stores NULL when tmux_pane_id is omitted', () => {
    const { db, repo } = freshRepo()
    const r = repo.register({ model: 'gpt-5', role: 'reviewer', name: 'bob' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r.agent_id) as { tmux_pane_id: string | null }
    expect(row.tmux_pane_id).toBeNull()
    db.close()
  })

  it('upserts tmux_pane_id when same identity re-registers', () => {
    const { db, repo } = freshRepo()
    const r1 = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    const r2 = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%99' })
    expect(r2.agent_id).toBe(r1.agent_id)
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%99')
    db.close()
  })

  it('preserves existing tmux_pane_id when re-register omits the field', () => {
    const { db, repo } = freshRepo()
    const r1 = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%42')
    db.close()
  })

  it('list returns tmux_pane_id for every agent (null when unset)', () => {
    const { db, repo } = freshRepo()
    const rA = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    const rB = repo.register({ model: 'gpt-5', role: 'reviewer', name: 'bob' })
    const rows = repo.list({ team: 'default' })
    const a = rows.find(r => r.agent_id === rA.agent_id)
    const b = rows.find(r => r.agent_id === rB.agent_id)
    expect(a?.tmux_pane_id).toBe('%42')
    expect(b?.tmux_pane_id).toBeNull()
    db.close()
  })

  it('stores non-tmux opaque strings verbatim', () => {
    const { db, repo } = freshRepo()
    const r = repo.register({ model: 'custom', role: 'exec', name: 'carol', tmux_pane_id: 'custom-pane-token-xyz' })
    const rows = repo.list({ team: 'default' })
    const c = rows.find(x => x.agent_id === r.agent_id)
    expect(c?.tmux_pane_id).toBe('custom-pane-token-xyz')
    db.close()
  })
})
