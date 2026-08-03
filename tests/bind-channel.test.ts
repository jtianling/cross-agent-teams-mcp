import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { BindChannelService } from '../src/mcp/bind-channel.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function setup() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const repo = new AgentsRepo(db)
  const fanout = new ChannelWakeFanout()
  const svc = new BindChannelService(db, fanout)
  return { dir, db, repo, fanout, svc }
}

describe('bind_channel service (self-binding)', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('updates caller delivery when csid has live sink and caller is non-proxy', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    fanout.attach('csid-abc', () => { /* sink */ }, 'proxy-session-1')
    const res = svc.bind({
      callerAgentId: alice.agent_id,
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ ok: true })
    const row = db.prepare(
      `SELECT agent_type, delivery_kind, delivery_payload, channel_session_id
       FROM agents
       WHERE agent_id=?`
    ).get(alice.agent_id) as {
      agent_type: string | null
      delivery_kind: string
      delivery_payload: string | null
      channel_session_id: string | null
    }
    expect(row.agent_type).toBe('claude-code')
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      channel_session_id: 'csid-abc',
    })
    expect(row.channel_session_id).toBeNull()
    db.close()
  })

  it('returns unknown_channel_session when no sink is attached for csid', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const res = svc.bind({
      callerAgentId: alice.agent_id,
      channel_session_id: 'csid-ghost'
    })
    expect(res).toEqual({ error: 'unknown_channel_session' })
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload, channel_session_id
       FROM agents
       WHERE agent_id=?`
    ).get(alice.agent_id) as {
      delivery_kind: string
      delivery_payload: string | null
      channel_session_id: string | null
    }
    expect(row.delivery_kind).toBe('none')
    expect(row.delivery_payload).toBeNull()
    expect(row.channel_session_id).toBeNull()
    db.close()
  })

  it('rejects proxy caller with forbidden_role', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    const proxy = repo.register({ model: 'proxy', role: '__channel_proxy__', name: 'p1' })
    fanout.attach('csid-abc', () => { /* sink */ }, 'proxy-session-1')
    const res = svc.bind({
      callerAgentId: proxy.agent_id,
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ error: 'forbidden_role' })
    db.close()
  })

  it('returns unknown_agent when caller is not registered', () => {
    const { dir, db, svc } = setup(); cleanups.push(dir)
    const res = svc.bind({
      callerAgentId: 'ghost',
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ error: 'unknown_agent' })
    db.close()
  })

  it('returns invalid_channel_session_id when csid is blank', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const res = svc.bind({
      callerAgentId: alice.agent_id,
      channel_session_id: '   '
    })
    expect(res).toEqual({ error: 'invalid_channel_session_id' })
    db.close()
  })

  it('leaves legacy channel_session_id column untouched after successful bind', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    db.prepare(`UPDATE agents SET channel_session_id=? WHERE agent_id=?`).run(
      'legacy-csid',
      alice.agent_id
    )
    fanout.attach('csid-new', () => { /* sink */ }, 'proxy-session-1')

    const res = svc.bind({
      callerAgentId: alice.agent_id,
      channel_session_id: 'csid-new'
    })

    expect(res).toEqual({ ok: true })
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload, channel_session_id
       FROM agents
       WHERE agent_id=?`
    ).get(alice.agent_id) as {
      delivery_kind: string
      delivery_payload: string | null
      channel_session_id: string | null
    }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      channel_session_id: 'csid-new',
    })
    expect(row.channel_session_id).toBe('legacy-csid')
    db.close()
  })

  it('does not replace a generation-aware OpenCode runtime', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    const caller = repo.register({
      agent_type: 'opencode',
      model: 'gpt',
      role: 'worker',
      name: 'runtime-aware',
      identity_key: 'runtime-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:18888',
        session_id: 'ses_runtime',
        runtime_generation: 2,
        auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
      },
    })
    fanout.attach('csid-new', () => { /* sink */ }, 'proxy-session-1')
    const before = db.prepare(
      `SELECT agent_type, delivery_kind, delivery_payload, identity_key,
              opencode_runtime_generation, register_generation
       FROM agents WHERE agent_id = ?`
    ).get(caller.agent_id)

    expect(svc.bind({
      callerAgentId: caller.agent_id,
      channel_session_id: 'csid-new',
    })).toEqual({ error: 'opencode_runtime_coordinates_required' })
    const after = db.prepare(
      `SELECT agent_type, delivery_kind, delivery_payload, identity_key,
              opencode_runtime_generation, register_generation
       FROM agents WHERE agent_id = ?`
    ).get(caller.agent_id)
    expect(after).toEqual(before)
    db.close()
  })
})
