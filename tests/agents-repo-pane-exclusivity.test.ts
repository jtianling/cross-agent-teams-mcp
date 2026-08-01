import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const PANE = '%19'

interface Ctx {
  db: ReturnType<typeof openDb>
  repo: AgentsRepo
}

function paneOf(ctx: Ctx, agent_id: string): string | null {
  return (ctx.db.prepare('SELECT tmux_pane_id FROM agents WHERE agent_id=?')
    .get(agent_id) as { tmux_pane_id: string | null }).tmux_pane_id
}

function bind(repo: AgentsRepo, agent_id: string, pane: string, ui_pid = 4242): void {
  repo.setRuntimeBinding(agent_id, {
    tmux_pane_id: pane,
    runtime_ui_pid: ui_pid,
    runtime_tty: 'ttys019',
    runtime_verification_mode: 'verified_pid_tty_pane',
  })
}

describe('pane binding is exclusive per device (last-writer-wins)', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function fresh(): Ctx {
    const dir = mkdtempSync(join(tmpdir(), 'atm-pane-excl-'))
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, repo: new AgentsRepo(db) }
  }

  it('a new binding unbinds the incumbent and leaves the rest of its row intact', () => {
    const ctx = fresh()
    const a = ctx.repo.register({ device: 'jt', team: 't', name: 'alice' })
    const b = ctx.repo.register({ device: 'jt', team: 't', name: 'bob' })
    bind(ctx.repo, a.agent_id, PANE, 7001)
    const before = ctx.db.prepare('SELECT * FROM agents WHERE agent_id=?').get(a.agent_id) as Record<string, unknown>
    expect(before.runtime_ui_pid).toBe(7001)

    bind(ctx.repo, b.agent_id, PANE, 7002)

    expect(paneOf(ctx, b.agent_id)).toBe(PANE)
    expect(paneOf(ctx, a.agent_id)).toBeNull()
    const after = ctx.db.prepare('SELECT * FROM agents WHERE agent_id=?').get(a.agent_id) as Record<string, unknown>
    // runtime_ui_pid in particular MUST survive: the identity_key four-branch
    // rule reads it to tell a rename-migration from two panes racing for one
    // key, and a silently cleared pid turns a conflict into a quiet pass.
    expect(after.runtime_ui_pid).toBe(7001)
    // The evicted pane is remembered, by the same statement that clears it:
    // seat-follow's dead-holder branch asks "is the pane this row lost the
    // pane the caller now holds?", which nothing else in the row can answer.
    expect(after.prev_tmux_pane_id).toBe(PANE)
    for (const key of Object.keys(before)) {
      if (key === 'tmux_pane_id' || key === 'prev_tmux_pane_id') continue
      expect([key, after[key]]).toEqual([key, before[key]])
    }
  })

  it('register-time pane binding evicts the incumbent too', () => {
    const ctx = fresh()
    const a = ctx.repo.register({ device: 'jt', team: 't', name: 'alice', tmux_pane_id: PANE })
    const b = ctx.repo.register({ device: 'jt', team: 't', name: 'bob', tmux_pane_id: PANE })
    expect(paneOf(ctx, b.agent_id)).toBe(PANE)
    expect(paneOf(ctx, a.agent_id)).toBeNull()
  })

  it('the same pane id on another device is untouched', () => {
    const ctx = fresh()
    const c = ctx.repo.register({ device: 'gx', team: 't', name: 'carol', tmux_pane_id: PANE })
    const b = ctx.repo.register({ device: 'jt', team: 't', name: 'bob' })
    bind(ctx.repo, b.agent_id, PANE)
    expect(paneOf(ctx, c.agent_id)).toBe(PANE)
    expect(paneOf(ctx, b.agent_id)).toBe(PANE)
  })

  it('re-binding the same agent to the same pane is idempotent', () => {
    const ctx = fresh()
    const b = ctx.repo.register({ device: 'jt', team: 't', name: 'bob' })
    bind(ctx.repo, b.agent_id, PANE)
    bind(ctx.repo, b.agent_id, PANE)
    expect(paneOf(ctx, b.agent_id)).toBe(PANE)
  })

  it('no (device, pane) group ever holds more than one row', () => {
    const ctx = fresh()
    const ids = ['alice', 'bob', 'carol'].map(name =>
      ctx.repo.register({ device: 'jt', team: 't', name }).agent_id)
    const remote = ctx.repo.register({ device: 'gx', team: 't', name: 'dave' }).agent_id

    bind(ctx.repo, ids[0], PANE)
    bind(ctx.repo, ids[1], '%7')
    bind(ctx.repo, remote, PANE)
    bind(ctx.repo, ids[2], PANE)
    bind(ctx.repo, ids[0], '%7')

    const dupes = ctx.db.prepare(
      `SELECT device, tmux_pane_id, COUNT(*) AS n
       FROM agents
       WHERE tmux_pane_id IS NOT NULL
       GROUP BY device, tmux_pane_id
       HAVING n > 1`
    ).all()
    expect(dupes).toEqual([])
  })
})
