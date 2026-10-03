import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { BroadcastToRoleService } from '../src/mcp/broadcast-to-role.js'
import type { AutoPokeFn, AutoPokeSkipReason } from '../src/mcp/auto-poke-fanout.js'
import { buildAutoPokeHint } from '../src/mcp/tools.js'
import { __setCapturePaneTail, __resetCapturePaneTail } from '../src/mcp/poke-guard.js'
import { clearAllRetries } from '../src/mcp/poke-retry.js'
import { insertAgent } from './helpers/insert-agent.js'
import { guardingPoke } from './helpers/guarding-poke.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-btr-'))

interface PokeCall { target: string; pane: string | null; prompt: string }

function setup(opts?: { paneState?: Record<string, 'idle' | 'active'> }): {
  svc: BroadcastToRoleService
  db: ReturnType<typeof openDb>
  pokes: PokeCall[]
  cleanup: () => void
} {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)

  const panes = opts?.paneState ?? {}
  __setCapturePaneTail(async (paneId: string) => {
    const state = panes[paneId] ?? 'idle'
    if (state === 'idle') return `idle-${paneId}`
    return `active-${paneId}-${Math.random()}`
  })

  const pokes: PokeCall[] = []
  const fakePoke: AutoPokeFn = guardingPoke(
    async ({ fromAgentId, targetAgentId, paneId }) => {
      // Mirrors createAutoPokeImpl: sender row plus the target row, so the
      // per-recipient target segment is exercised here too.
      const row = db.prepare('SELECT name, team FROM agents WHERE agent_id=?').get(fromAgentId) as
        { name: string | null; team: string } | undefined
      const target = db.prepare('SELECT name, team FROM agents WHERE agent_id=?').get(targetAgentId) as
        { name: string | null; team: string } | undefined
      const prompt = buildAutoPokeHint(row, fromAgentId, target)
      pokes.push({ target: targetAgentId, pane: paneId, prompt })
      return { ok: true }
    }
  )

  const svc = new BroadcastToRoleService(db, agents, events, { poke: fakePoke })
  return { svc, db, pokes, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('broadcast_to_role', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => { process.env.POKE_QUIET_MS = '50' })
  afterEach(() => {
    cleanups.forEach(c => c()); cleanups.length = 0
    __resetCapturePaneTail()
    delete process.env.POKE_QUIET_MS
    clearAllRetries()
  })

  it('fans out to same-team role, excludes sender, writes paired rows', async () => {
    const { svc, db, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead', tmux_pane_id: '%S' })
    insertAgent(db, { agent_id: 'F1', team: 'default', role: 'frontend', tmux_pane_id: '%F1' })
    insertAgent(db, { agent_id: 'F2', team: 'default', role: 'frontend', tmux_pane_id: '%F2' })
    const r = await svc.broadcast({ from: 'S', to_role: 'frontend', body: 'ship status', auto_poke: false })
    if ('error' in r) throw new Error(r.error)
    expect(new Set(r.recipients)).toEqual(new Set(['F1', 'F2']))
    const rows = db.prepare(`SELECT from_team, to_team, to_role, to_agent_id, event_id FROM messages`).all() as
      Array<{ from_team: string; to_team: string; to_role: string; to_agent_id: string; event_id: number }>
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.from_team).toBe('default')
      expect(row.to_team).toBe('default')
      expect(row.to_role).toBe('frontend')
      expect(['F1', 'F2']).toContain(row.to_agent_id)
    }
    // shared event_id across both rows
    expect(new Set(rows.map(row => row.event_id)).size).toBe(1)
  })

  it('role fan-out spans devices in the caller team', async () => {
    const { svc, db, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'S', device: 'jt', team: 'default', role: 'lead' })
    insertAgent(db, { agent_id: 'W1', device: 'jt', team: 'default', role: 'worker' })
    insertAgent(db, { agent_id: 'W2', device: 'gx', team: 'default', role: 'worker' })
    insertAgent(db, { agent_id: 'W3', device: 'gx', team: 'other', role: 'worker' })
    const r = await svc.broadcast({
      from: 'S',
      to_role: 'worker',
      body: 'task',
      auto_poke: false,
    })
    if ('error' in r) throw new Error(r.error)
    expect([...r.recipients].sort()).toEqual(['W1', 'W2'])
  })

  it('marks role fan-out rows no-reply', async () => {
    const { svc, db, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead' })
    insertAgent(db, { agent_id: 'F1', team: 'default', role: 'frontend' })
    insertAgent(db, { agent_id: 'F2', team: 'default', role: 'frontend' })
    const r = await svc.broadcast({
      from: 'S',
      to_role: 'frontend',
      body: 'status',
      auto_poke: false,
    })
    if ('error' in r) throw new Error(r.error)
    const rows = db.prepare(`SELECT need_reply FROM messages`).all() as
      Array<{ need_reply: number }>
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.need_reply === 0)).toBe(true)
  })

  it('returns unknown_recipient when no agent matches role', async () => {
    const { svc, db, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead' })
    const r = await svc.broadcast({ from: 'S', to_role: 'nonexistent', body: 'hi' })
    expect(r).toEqual({ error: 'unknown_recipient' })
    const ev = db.prepare(`SELECT * FROM events`).all()
    expect(ev).toHaveLength(0)
  })

  it('auto-poke fires for all idle-pane role recipients in parallel', async () => {
    const { svc, db, pokes, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead', name: 'captain', tmux_pane_id: '%S' })
    insertAgent(db, { agent_id: 'B', team: 'default', role: 'backend', tmux_pane_id: '%B' })
    insertAgent(db, { agent_id: 'C', team: 'default', role: 'backend', tmux_pane_id: '%C' })
    const t0 = Date.now()
    const r = await svc.broadcast({ from: 'S', to_role: 'backend', body: 'API_KEY=secret' })
    const elapsed = Date.now() - t0
    if ('error' in r) throw new Error(r.error)
    expect(r.poked).toBe(true)
    expect(pokes).toHaveLength(2)
    for (const p of pokes) {
      expect(p.prompt).toContain('新邮件 from captain')
      // Each recipient's hint names that recipient, not a shared or sender row.
      expect(p.prompt).toContain(`→ ${p.target}@default`)
      expect(p.prompt).not.toContain('API_KEY')
    }
    // parallel fan-out: under 400ms with POKE_QUIET_MS=50 per-recipient
    expect(elapsed).toBeLessThan(400)
  })

  it('mixed outcomes — only guard_failed recipients get retries', async () => {
    const { svc, db, pokes, cleanup } = setup({
      paneState: { '%B': 'idle', '%C': 'active' }
    })
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead', tmux_pane_id: '%S' })
    insertAgent(db, { agent_id: 'B', team: 'default', role: 'worker', tmux_pane_id: '%B' })
    insertAgent(db, { agent_id: 'C', team: 'default', role: 'worker', tmux_pane_id: '%C' })
    insertAgent(db, { agent_id: 'D', team: 'default', role: 'worker' }) // no pane

    const r = await svc.broadcast({ from: 'S', to_role: 'worker', body: 'urgent' })
    if ('error' in r) throw new Error(r.error)
    expect(r.recipients.sort()).toEqual(['B', 'C', 'D'])
    expect(pokes.map(p => p.target).sort()).toEqual(['B'])
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons).toContainEqual({ agent_id: 'C', reason: 'guard_failed' as AutoPokeSkipReason })
    expect(reasons).toContainEqual({ agent_id: 'D', reason: 'no_pane' as AutoPokeSkipReason })
    expect(r.retry_scheduled).toBe(true)
    expect(r.retry_delays_s).toEqual([30, 180, 600])
  })

  it('includes idle role members in fan-out and writes mailbox rows', async () => {
    const { svc, db, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', team: 'default', role: 'backend', name: 'A' })
    insertAgent(db, { agent_id: 'F1', team: 'default', role: 'frontend', name: 'F1' })
    insertAgent(db, { agent_id: 'F2', team: 'default', role: 'frontend', name: 'F2' })
    insertAgent(db, { agent_id: 'F3', team: 'default', role: 'frontend', name: 'F3' })
    const eightMinAgo = new Date(Date.now() - 8 * 60 * 1000).toISOString()
    db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(eightMinAgo, 'F2')

    const r = await svc.broadcast({ from: 'A', to_role: 'frontend', body: 'hi', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect([...r.recipients].sort()).toEqual(['F1', 'F2', 'F3'])
    const f2Rows = db.prepare('SELECT id FROM messages WHERE to_agent_id=?').all('F2') as unknown[]
    expect(f2Rows.length).toBe(1)
  })

  it('does not treat an idle role member as unknown_recipient', async () => {
    const { svc, db, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', team: 'default', role: 'backend', name: 'A' })
    insertAgent(db, { agent_id: 'F1', team: 'default', role: 'frontend', name: 'F1' })
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(sixMinAgo, 'F1')

    const r = await svc.broadcast({ from: 'A', to_role: 'frontend', body: 'hi', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect(r.recipients).toEqual(['F1'])
  })
})
