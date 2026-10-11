import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { type AutoPokeFn, type AutoPokeSkipReason } from '../src/mcp/send-message.js'
import { BroadcastService } from '../src/mcp/broadcast.js'
import { __setCapturePaneTail, __resetCapturePaneTail } from '../src/mcp/poke-guard.js'
import { clearAllRetries } from '../src/mcp/poke-retry.js'
import { insertAgent } from './helpers/insert-agent.js'
import { guardingPoke } from './helpers/guarding-poke.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-bcast-autopoke-'))

interface PokeCall { target: string; pane: string | null }

function setupService(opts?: { paneState?: Record<string, 'idle' | 'active'> }): {
  svc: BroadcastService
  db: ReturnType<typeof openDb>
  pokeCalls: PokeCall[]
  cleanup: () => void
} {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const agents = new AgentsRepo(db)

  const panes = opts?.paneState ?? {}
  __setCapturePaneTail(async (paneId: string) => {
    const state = Object.entries(panes).find(([pid]) => pid === paneId)?.[1] ?? 'idle'
    if (state === 'idle') return `idle-${paneId}`
    return `active-${paneId}-${Math.random()}`
  })

  const pokeCalls: PokeCall[] = []
  const fakePoke: AutoPokeFn = guardingPoke(
    async () => ({ ok: true }),
    ({ targetAgentId, paneId }) => { pokeCalls.push({ target: targetAgentId, pane: paneId }) }
  )

  const svc = new BroadcastService(db, agents, { poke: fakePoke })
  return { svc, db, pokeCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('broadcast auto_poke default-on integration', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => { process.env.POKE_QUIET_MS = '100' })
  afterEach(() => {
    cleanups.forEach(c => c()); cleanups.length = 0
    __resetCapturePaneTail()
    delete process.env.POKE_QUIET_MS
    clearAllRetries()
  })

  it('default broadcast (auto_poke omitted) pokes every idle pane in parallel', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'lead', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })
    insertAgent(db, { agent_id: 'C', model: 'm', role: 'worker', tmux_pane_id: '%3' , name: 'C' })
    insertAgent(db, { agent_id: 'D', model: 'm', role: 'worker', tmux_pane_id: '%4' , name: 'D' })

    const r = await svc.broadcast({ from: 'A', body: 'status update' })
    if ('error' in r) throw new Error('expected success')

    expect(r.recipients.sort()).toEqual(['B', 'C', 'D'])
    expect(r.poked).toBe(true)
    expect(pokeCalls.length).toBe(3)
    expect(pokeCalls.map(c => c.target).sort()).toEqual(['B', 'C', 'D'])
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons.length).toBe(0)
    expect(r.retry_scheduled).toBe(false)
    expect(r.retry_delays_s).toBeUndefined()
  })

  it('explicit auto_poke:false reverts to pure mailbox delivery', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'lead', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })
    insertAgent(db, { agent_id: 'C', model: 'm', role: 'worker', tmux_pane_id: '%3' , name: 'C' })

    const r = await svc.broadcast({ from: 'A', body: 'quiet note', auto_poke: false })
    if ('error' in r) throw new Error('expected success')

    expect(r.recipients.sort()).toEqual(['B', 'C'])
    expect(r.poked).toBe(false)
    expect(pokeCalls.length).toBe(0)
    expect(r.poke_skip_reasons).toBeUndefined()
    expect(r.retry_scheduled).toBe(false)
    expect(r.retry_delays_s).toBeUndefined()
  })

  it('default broadcast with mixed pane states reports per-recipient skip reasons and schedules retry for guard_failed', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({
      paneState: { '%2': 'idle', '%3': 'active' }
    })
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'lead', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })
    insertAgent(db, { agent_id: 'C', model: 'm', role: 'worker', tmux_pane_id: '%3' , name: 'C' })
    insertAgent(db, { agent_id: 'D', model: 'm', role: 'worker' , name: 'D' }) // no pane

    const r = await svc.broadcast({ from: 'A', body: 'urgent' })
    if ('error' in r) throw new Error('expected success')

    expect(r.recipients.sort()).toEqual(['B', 'C', 'D'])
    expect(pokeCalls.map(c => c.target).sort()).toEqual(['B'])
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons).toContainEqual({ agent_id: 'C', reason: 'guard_failed' as AutoPokeSkipReason })
    expect(reasons).toContainEqual({ agent_id: 'D', reason: 'no_pane' as AutoPokeSkipReason })
    expect(r.retry_scheduled).toBe(true)
    expect(r.retry_delays_s).toEqual([30, 180, 600])
  })

  it('broadcast writes from_team=to_team=caller.team for all recipients', async () => {
    const { svc, db, cleanup } = setupService()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', team: 'default' })
    insertAgent(db, { agent_id: 'B', team: 'default' })
    insertAgent(db, { agent_id: 'C', team: 'default' })
    const resp = await svc.broadcast({ from: 'A', body: 'hi', auto_poke: false })
    if ('error' in resp) throw new Error(resp.error)
    const rows = db.prepare(`SELECT from_team, to_team, event_id FROM messages`).all() as
      Array<{ from_team: string; to_team: string; event_id: number }>
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.from_team).toBe('default')
      expect(r.to_team).toBe('default')
    }
    const eventIds = new Set(rows.map(r => r.event_id))
    expect(eventIds.size).toBe(1)
    const e = db.prepare(`SELECT from_team, to_team FROM events WHERE event_id=?`)
      .get([...eventIds][0]) as { from_team: string; to_team: string }
    expect(e.from_team).toBe('default')
    expect(e.to_team).toBe('default')
  })

  it('broadcast spans devices in caller team and excludes channel proxies', async () => {
    const { svc, db, cleanup } = setupService()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', device: 'jt', team: 'default', role: 'lead', name: 'A' })
    insertAgent(db, { agent_id: 'B', device: 'jt', team: 'default', role: 'worker', name: 'B' })
    insertAgent(db, { agent_id: 'C', device: 'gx', team: 'default', role: 'worker', name: 'C' })
    insertAgent(db, { agent_id: 'P', device: 'gx', team: 'default', role: '__channel_proxy__', name: 'P' })
    insertAgent(db, { agent_id: 'D', device: 'gx', team: 'other', role: 'worker', name: 'D' })

    const resp = await svc.broadcast({ from: 'A', body: 'hi', auto_poke: false })
    if ('error' in resp) throw new Error(resp.error)
    expect([...resp.recipients].sort()).toEqual(['B', 'C'])
  })

  it('broadcast rows are marked no-reply', async () => {
    const { svc, db, cleanup } = setupService()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', team: 'default' })
    insertAgent(db, { agent_id: 'B', team: 'default' })
    insertAgent(db, { agent_id: 'C', team: 'default' })
    const resp = await svc.broadcast({ from: 'A', body: 'FYI', auto_poke: false })
    if ('error' in resp) throw new Error(resp.error)
    const rows = db.prepare(`SELECT need_reply FROM messages`).all() as
      Array<{ need_reply: number }>
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.need_reply === 0)).toBe(true)
  })

  it('explicit auto_poke:true with active pane: guard_failed → retry_scheduled:true, delays=[30,180,600]', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({
      paneState: { '%2': 'active' }
    })
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'lead', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })

    const r = await svc.broadcast({ from: 'A', body: 'urgent', auto_poke: true })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(false)
    expect(pokeCalls.length).toBe(0)
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons).toContainEqual({ agent_id: 'B', reason: 'guard_failed' as AutoPokeSkipReason })
    expect(r.retry_scheduled).toBe(true)
    expect(r.retry_delays_s).toEqual([30, 180, 600])
  })

  it('includes idle agents in fan-out and writes mailbox rows', async () => {
    const { svc, db, cleanup } = setupService()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend', name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'backend', name: 'B' })
    insertAgent(db, { agent_id: 'C', model: 'm', role: 'backend', name: 'C' })
    insertAgent(db, { agent_id: 'D', model: 'm', role: 'backend', name: 'D' })
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const thirtySecAgo = new Date(Date.now() - 30 * 1000).toISOString()
    db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(tenMinAgo, 'C')
    db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(thirtySecAgo, 'D')

    const r = await svc.broadcast({ from: 'A', body: 'x', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect([...r.recipients].sort()).toEqual(['B', 'C', 'D'])
    expect(r.skipped_inactive).toBe(0)

    const cRows = db.prepare('SELECT id FROM messages WHERE to_agent_id=?').all('C') as unknown[]
    expect(cRows.length).toBe(1)

    const ev = db.prepare('SELECT payload FROM events WHERE event_id=?').get(r.event_id) as
      { payload: string }
    const payload = JSON.parse(ev.payload) as { recipients: string[] }
    expect([...payload.recipients].sort()).toEqual(['B', 'C', 'D'])
  })

  it('does not treat an idle non-sender as unknown_recipient', async () => {
    const { svc, db, cleanup } = setupService()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend', name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'backend', name: 'B' })
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(sixMinAgo, 'B')

    const eventsBefore = (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c
    const msgsBefore = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c

    const r = await svc.broadcast({ from: 'A', body: 'x', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect(r.recipients).toEqual(['B'])

    const eventsAfter = (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c
    const msgsAfter = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c
    expect(eventsAfter).toBe(eventsBefore + 1)
    expect(msgsAfter).toBe(msgsBefore + 1)
  })
})
