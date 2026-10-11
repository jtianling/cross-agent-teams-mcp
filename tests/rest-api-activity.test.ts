import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { insertAgent } from './helpers/insert-agent.js'

// Every subprocess fails as if tmux were absent, so this file can never
// reach the host's tmux server through /api/agents or a wake attempt.
vi.mock('node:child_process', () => {
  const fail = (...args: unknown[]): void => {
    const cb = args[args.length - 1]
    if (typeof cb === 'function') cb(new Error('subprocess disabled in test'))
  }
  return {
    execFile: vi.fn(fail),
    execFileSync: vi.fn(() => { throw new Error('subprocess disabled in test') }),
    spawn: vi.fn(() => { throw new Error('subprocess disabled in test') }),
  }
})

const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86400 * 1000).toISOString()

describe('rest fallback api — send and inbox count as activity', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closers) await close()
    closers.length = 0
  })

  async function boot(): Promise<{
    base: string
    lastSeen: (agent_id: string) => string
    messages: () => number
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'atm-rest-activity-'))
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({
      dbPath, port: 0, host: '127.0.0.1', localDevice: 'local',
    })
    const db = openDb(dbPath)
    insertAgent(db, { agent_id: 'alice', last_seen_at: TEN_DAYS_AGO })
    insertAgent(db, { agent_id: 'bob', last_seen_at: TEN_DAYS_AGO })
    closers.push(async () => {
      await app.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    })
    return {
      base: `http://${host}:${port}`,
      lastSeen: agent_id => (db.prepare(
        'SELECT last_seen_at FROM agents WHERE agent_id=?'
      ).get(agent_id) as { last_seen_at: string }).last_seen_at,
      messages: () => (db.prepare('SELECT COUNT(*) AS c FROM messages')
        .get() as { c: number }).c,
    }
  }

  function send(base: string, from: string, to: string): Promise<Response> {
    return fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: { team: 'default', name: from },
        to: { name: to },
        body: 'hello',
        auto_poke: false,
      }),
    })
  }

  function ageMs(iso: string): number {
    return Date.now() - new Date(iso).getTime()
  }

  it('POST /api/send refreshes the sender only', async () => {
    const h = await boot()

    const res = await send(h.base, 'alice', 'bob')

    expect(res.status).toBe(200)
    expect(h.messages()).toBe(1)
    expect(ageMs(h.lastSeen('alice'))).toBeLessThan(1000)
    expect(h.lastSeen('bob')).toBe(TEN_DAYS_AGO)
  })

  it('GET /api/inbox refreshes the owner', async () => {
    const h = await boot()

    const res = await fetch(`${h.base}/api/inbox?team=default&name=alice`)

    expect(res.status).toBe(200)
    expect(ageMs(h.lastSeen('alice'))).toBeLessThan(1000)
    expect(h.lastSeen('bob')).toBe(TEN_DAYS_AGO)
  })

  it('GET /api/agents is not activity', async () => {
    const h = await boot()

    const res = await fetch(`${h.base}/api/agents?team=default`)

    expect(res.status).toBe(200)
    expect(h.lastSeen('alice')).toBe(TEN_DAYS_AGO)
    expect(h.lastSeen('bob')).toBe(TEN_DAYS_AGO)
  })

  it('a failed send touches no row', async () => {
    const h = await boot()

    const unknownRecipient = await send(h.base, 'alice', 'nobody')
    const unknownSender = await send(h.base, 'nobody', 'bob')
    const invalid = await fetch(`${h.base}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: { team: 'default', name: 'alice' } }),
    })

    expect([unknownRecipient.status, unknownSender.status, invalid.status])
      .toEqual([404, 404, 400])
    expect(h.lastSeen('alice')).toBe(TEN_DAYS_AGO)
    expect(h.lastSeen('bob')).toBe(TEN_DAYS_AGO)
  })

  it('an inbox read for an unknown owner touches no row', async () => {
    const h = await boot()

    const res = await fetch(`${h.base}/api/inbox?team=default&name=nobody`)

    expect(res.status).toBe(404)
    expect(h.lastSeen('alice')).toBe(TEN_DAYS_AGO)
  })
})
