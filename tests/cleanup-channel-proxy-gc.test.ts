import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { runCleanup } from '../src/daemon/cleanup.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-cleanup-proxy-'))

const DAY_MS = 86400 * 1000

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

// RED tests for the change `clean-channel-proxy-noise`, tasks 4.2 / 4.3.
// Until `runCleanup` learns to prune `agents` rows where role='__channel_proxy__'
// AND last_seen_at < now-30d AND not referenced as a live channel_session_id
// (design D3 / D4), these expectations fail because no proxy rows are deleted.
describe('runCleanup channel-proxy GC', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function fresh(): ReturnType<typeof openDb> {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return db
  }

  function agentCount(db: ReturnType<typeof openDb>, agent_id: string): number {
    return (db.prepare('SELECT COUNT(*) c FROM agents WHERE agent_id=?').get(agent_id) as { c: number }).c
  }

  it('deletes a stale, unreferenced channel proxy row', () => {
    const db = fresh()
    insertAgent(db, {
      agent_id: 'P-stale',
      role: '__channel_proxy__',
      name: 'channel-proxy-stale',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-stale' },
      last_seen_at: isoDaysAgo(31),
      registered_at: isoDaysAgo(60),
    })
    expect(agentCount(db, 'P-stale')).toBe(1)
    const res = runCleanup(db)
    expect(agentCount(db, 'P-stale')).toBe(0)
    expect(res.deleted).toBeGreaterThanOrEqual(1)
    db.close()
  })

  it('retains a stale channel proxy still bound to a live host', () => {
    const db = fresh()
    insertAgent(db, {
      agent_id: 'P-bound',
      role: '__channel_proxy__',
      name: 'channel-proxy-bound',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-X' },
      last_seen_at: isoDaysAgo(90),
      registered_at: isoDaysAgo(120),
    })
    insertAgent(db, {
      agent_id: 'H-host',
      role: 'backend',
      name: 'host',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-X' },
    })
    runCleanup(db)
    expect(agentCount(db, 'P-bound')).toBe(1)
    // Host's delivery_payload remains untouched.
    const host = db.prepare('SELECT delivery_kind, delivery_payload FROM agents WHERE agent_id=?').get('H-host') as { delivery_kind: string; delivery_payload: string }
    expect(host.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(host.delivery_payload).channel_session_id).toBe('csid-X')
    db.close()
  })

  it('retains a recent channel proxy regardless of references', () => {
    const db = fresh()
    insertAgent(db, {
      agent_id: 'P-fresh',
      role: '__channel_proxy__',
      name: 'channel-proxy-fresh',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-fresh' },
      last_seen_at: isoDaysAgo(1),
    })
    runCleanup(db)
    expect(agentCount(db, 'P-fresh')).toBe(1)
    db.close()
  })

  it('expires an ancient non-proxy agent row', () => {
    const db = fresh()
    insertAgent(db, {
      agent_id: 'biz-old',
      role: 'backend',
      name: 'alice',
      last_seen_at: isoDaysAgo(120),
      registered_at: isoDaysAgo(120),
    })
    runCleanup(db)
    expect(agentCount(db, 'biz-old')).toBe(0)
    db.close()
  })

  it('reaps a stale proxy in the same pass that expires its only host', () => {
    const db = fresh()
    insertAgent(db, {
      agent_id: 'P-orphaned',
      role: '__channel_proxy__',
      name: 'channel-proxy-orphaned',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-Y' },
      last_seen_at: isoDaysAgo(90),
    })
    insertAgent(db, {
      agent_id: 'H-expired',
      role: 'backend',
      name: 'host-expired',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-Y' },
      last_seen_at: isoDaysAgo(31),
    })
    const res = runCleanup(db)
    expect(agentCount(db, 'H-expired')).toBe(0)
    expect(agentCount(db, 'P-orphaned')).toBe(0)
    expect(res.deleted).toBe(2)
    db.close()
  })

  it('GC happens inside the same transaction: events / messages / proxy all commit atomically', () => {
    const db = fresh()
    // Stale event + message + delivery_status.
    const ts = isoDaysAgo(31)
    insertAgent(db, { agent_id: 'B', role: 'backend', name: 'bob' })
    db.prepare(`INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?,?)`)
      .run('default', 'default', 'message_sent', null, '{}', ts)
    const event_id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
    db.prepare(
      `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
       VALUES ('m-old', ?, 'default', 'default', 'sender', 'B', null, null, 'b', ?)`
    ).run(event_id, ts)
    db.prepare(
      `INSERT INTO message_delivery_status (message_id, agent_id, wake_status, retry_attempts, updated_at)
       VALUES ('m-old', 'B', 'delivered', 0, ?)`
    ).run(ts)
    // Stale unreferenced proxy.
    insertAgent(db, {
      agent_id: 'P-stale',
      role: '__channel_proxy__',
      name: 'channel-proxy-stale',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-stale' },
      last_seen_at: ts,
    })
    const res = runCleanup(db)
    // 1 status + 1 message + 1 event + 1 proxy = 4
    expect(res.deleted).toBe(4)
    expect((db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) c FROM message_delivery_status').get() as { c: number }).c).toBe(0)
    expect(agentCount(db, 'P-stale')).toBe(0)
    // Non-proxy survives.
    expect(agentCount(db, 'B')).toBe(1)
    db.close()
  })

  it('deletes events referencing a stale proxy before deleting the proxy itself (FK-safe order)', () => {
    const db = fresh()
    const ts = isoDaysAgo(31)
    insertAgent(db, {
      agent_id: 'P-stale',
      role: '__channel_proxy__',
      name: 'channel-proxy-stale',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-stale' },
      last_seen_at: ts,
    })
    db.prepare(`INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?,?)`)
      .run('default', 'default', 'channel_proxy_seen', 'P-stale', '{}', ts)
    expect(() => runCleanup(db)).not.toThrow()
    expect(agentCount(db, 'P-stale')).toBe(0)
    expect((db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c).toBe(0)
    db.close()
  })
})
