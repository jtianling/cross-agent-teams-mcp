import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { AutoBindChannelService } from '../src/mcp/auto-bind-channel.js'
import { CHANNEL_PROXY_ROLE } from '../src/mcp/subscribe-channel-wake.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-auto-bind-'))

function setup() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const repo = new AgentsRepo(db)
  const fanout = new ChannelWakeFanout()
  const svc = new AutoBindChannelService(db, fanout)
  return { dir, db, repo, fanout, svc }
}

describe('AutoBindChannelService', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('returns most recent live proxy row when multiple share claude_ui_pid (6.4)', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    // Write two proxy rows sharing claude_ui_pid=1234, same team
    repo.register({
      agent_type: 'custom',
      agent_type_name: 'cross-agent-teams-channel',
      model: 'proxy',
      role: CHANNEL_PROXY_ROLE,
      name: 'proxy-older',
      team: 'default',
      claude_ui_pid: 1234,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-old' },
    })
    // Manually stale the older row so last_seen_at differs deterministically
    const older = new Date(Date.now() - 60_000).toISOString()
    db.prepare(`UPDATE agents SET last_seen_at=? WHERE name='proxy-older'`).run(older)
    repo.register({
      agent_type: 'custom',
      agent_type_name: 'cross-agent-teams-channel',
      model: 'proxy',
      role: CHANNEL_PROXY_ROLE,
      name: 'proxy-newer',
      team: 'default',
      claude_ui_pid: 1234,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-new' },
    })
    fanout.attach('csid-new', () => { /* sink */ }, 'proxy-sess-new')
    fanout.attach('csid-old', () => { /* sink */ }, 'proxy-sess-old')

    const caller = repo.register({
      agent_type: 'claude-code',
      model: 'opus',
      role: 'worker',
      name: 'host',
      team: 'default',
      runtime_ui_pid: 1234,
    })
    const res = svc.run({ callerAgentId: caller.agent_id, ui_pid: 1234 })
    expect(res).toEqual({ ok: true, channel_session_id: 'csid-new' })
    db.close()
  })

  it('returns no_proxy_row when no __channel_proxy__ matches', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const caller = repo.register({
      agent_type: 'claude-code',
      model: 'opus',
      role: 'worker',
      name: 'host',
      team: 'default',
      runtime_ui_pid: 9999,
    })
    const res = svc.run({ callerAgentId: caller.agent_id, ui_pid: 9999 })
    expect(res).toEqual({ ok: false, reason: 'no_proxy_row' })
    db.close()
  })

  it('does not match a proxy row on another device when PIDs collide', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    repo.register({
      agent_type: 'custom',
      device: 'jt',
      model: 'proxy',
      role: CHANNEL_PROXY_ROLE,
      name: 'proxy-jt',
      team: 'default',
      claude_ui_pid: 555,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-jt' },
    })
    fanout.attach('csid-jt', () => { /* sink */ }, 'sess-jt')
    const caller = repo.register({
      agent_type: 'claude-code',
      device: 'gx',
      model: 'opus',
      role: 'worker',
      name: 'host',
      team: 'default',
      runtime_ui_pid: 555,
    })
    const res = svc.run({ callerAgentId: caller.agent_id, ui_pid: 555 })
    expect(res).toEqual({ ok: false, reason: 'no_proxy_row' })
    db.close()
  })

  it('returns sink_not_live when proxy row exists but fanout has no sink', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    repo.register({
      agent_type: 'custom',
      model: 'proxy',
      role: CHANNEL_PROXY_ROLE,
      name: 'proxy-1',
      team: 'default',
      claude_ui_pid: 555,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-dead' },
    })
    const caller = repo.register({
      agent_type: 'claude-code',
      model: 'opus',
      role: 'worker',
      name: 'host',
      team: 'default',
    })
    const res = svc.run({ callerAgentId: caller.agent_id, ui_pid: 555 })
    expect(res).toEqual({ ok: false, reason: 'sink_not_live' })
    db.close()
  })

  it('ignores team: proxy row in team A still matches caller in team B when claude_ui_pid aligns', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    repo.register({
      agent_type: 'custom',
      model: 'proxy',
      role: CHANNEL_PROXY_ROLE,
      name: 'proxy-1',
      team: 'default',
      claude_ui_pid: 42,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-alpha' },
    })
    fanout.attach('csid-alpha', () => { /* sink */ }, 'sess-p')
    const caller = repo.register({
      agent_type: 'claude-code',
      model: 'opus',
      role: 'worker',
      name: 'host',
      team: 'alpha',
    })
    const res = svc.run({ callerAgentId: caller.agent_id, ui_pid: 42 })
    expect(res).toEqual({ ok: true, channel_session_id: 'csid-alpha' })
    db.close()
  })

  it('skips stale proxy rows older than 5 minutes', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    repo.register({
      agent_type: 'custom',
      model: 'proxy',
      role: CHANNEL_PROXY_ROLE,
      name: 'proxy-stale',
      team: 'default',
      claude_ui_pid: 77,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-stale' },
    })
    const oldIso = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    db.prepare(`UPDATE agents SET last_seen_at=? WHERE name='proxy-stale'`).run(oldIso)
    fanout.attach('csid-stale', () => { /* sink */ }, 'sess-stale')
    const caller = repo.register({
      agent_type: 'claude-code',
      model: 'opus',
      role: 'worker',
      name: 'host',
      team: 'default',
    })
    const res = svc.run({ callerAgentId: caller.agent_id, ui_pid: 77 })
    expect(res).toEqual({ ok: false, reason: 'no_proxy_row' })
    db.close()
  })

  it('does not replace a generation-aware OpenCode runtime', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    repo.register({
      agent_type: 'custom',
      model: 'proxy',
      role: CHANNEL_PROXY_ROLE,
      name: 'proxy-1',
      team: 'default',
      claude_ui_pid: 55,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-live' },
    })
    fanout.attach('csid-live', () => { /* sink */ }, 'sess-live')
    const caller = repo.register({
      agent_type: 'opencode',
      model: 'gpt',
      role: 'worker',
      name: 'runtime-aware',
      team: 'default',
      identity_key: 'runtime-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:18888',
        session_id: 'ses_runtime',
        runtime_generation: 2,
      },
    })
    const before = db.prepare(
      `SELECT agent_type, delivery_kind, delivery_payload, identity_key,
              opencode_runtime_generation, register_generation
       FROM agents WHERE agent_id = ?`
    ).get(caller.agent_id)

    expect(svc.run({ callerAgentId: caller.agent_id, ui_pid: 55 })).toEqual({
      ok: false,
      reason: 'opencode_runtime_coordinates_required',
    })
    const after = db.prepare(
      `SELECT agent_type, delivery_kind, delivery_payload, identity_key,
              opencode_runtime_generation, register_generation
       FROM agents WHERE agent_id = ?`
    ).get(caller.agent_id)
    expect(after).toEqual(before)
    db.close()
  })
})
