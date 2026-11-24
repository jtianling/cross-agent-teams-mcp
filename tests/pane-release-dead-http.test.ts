import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import type { PaneProbes } from '../src/pane-lookup/probes.js'

const start = 1794566104
const coordinates = (number: number) => ({ socket_path: '/private/fixture/http.sock',
  server_pid: 400, server_started_at: start, pane_id: `%${number}` })
const input = () => ({ protocol_version: 1, targets: [
  { tmux: coordinates(1), identity_key: 'fixture-live-key' },
  { tmux: coordinates(2), identity_key: 'fixture-dead-key',
    allow_dead_if_identity_unclaimed: true },
] })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dead-pane-http-'))
  const dbPath = join(dir, 'data.db')
  const live = { pid: 101, pgid: 101, tpgid: 101, tty: 'pts/1',
    stat: 'S+', started_at: (start + 2) * 1000, command: '/usr/bin/claude' }
  const probes: PaneProbes = {
    socket: vi.fn(async () => ({ path: coordinates(1).socket_path,
      device: 1, inode: 2, uid: 501 })),
    panes: vi.fn(async () => [
      { ...coordinates(1), pane_pid: 101, tty: 'pts/1', dead: false },
      { ...coordinates(2), pane_pid: 0, tty: '', dead: true },
    ]),
    process: vi.fn(async pid => pid === 101 ? live : undefined),
    ttyProcesses: vi.fn(async tty => tty === 'pts/1' ? [live] : []),
  }
  const server = await startServer({ dbPath, port: 0, localDevice: 'local',
    token: 'dead-http-fixture-token', paneReleaseProbes: probes, mcpLog: vi.fn() })
  const db = openDb(dbPath)
  cleanups.push(async () => {
    db.close()
    await server.app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const peer = new AgentsRepo(db).register({ name: 'peer', team: 'project',
    device: 'local', agent_type: 'claude-code', identity_key: 'fixture-live-key' })
  db.prepare(`UPDATE agents SET tmux_pane_id='%1',runtime_ui_pid=101,
    runtime_tty='pts/1',runtime_verification_mode='verified_pid_tty_pane',
    runtime_bound_at=? WHERE agent_id=?`)
    .run(new Date((start + 20) * 1000).toISOString(), peer.agent_id)
  const url = `http://${server.host}:${server.port}`
  const headers = { authorization: 'Bearer dead-http-fixture-token',
    'content-type': 'application/json' }
  const post = (body: object, path = '/api/runtime/panes/release') =>
    fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) })
  return { ...server, url, headers, post, db, peer, probes }
}

describe('dead target real loopback HTTP boundary', () => {
  it('releases a mixed batch with no key or process leak', async () => {
    const h = await setup()
    const response = await h.post(input())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ ok: true, protocol_version: 1, results: [
      { index: 0, state: 'released', agent: { agent_id: h.peer.agent_id } },
      { index: 1, state: 'dead_key_unclaimed', agent: null },
    ] })
    expect(JSON.stringify(result)).not.toContain('fixture-dead-key')
    expect(JSON.stringify(result)).not.toContain('command')
    expect(new AgentsRepo(h.db).findById(h.peer.agent_id)).toBeUndefined()
    expect(h.probes.process).not.toHaveBeenCalledWith(0)
  })

  it.each(['prepared', 'bound'])('rejects a %s claim via HTTP', async state => {
    const h = await setup()
    h.db.prepare(`INSERT INTO managed_claims
      (claim_id,device,name,team,agent_type,identity_key,instance_id,generation,
       token_hash,state) VALUES ('claim','local','managed','project','codex',
       'fixture-dead-key','fixture-instance',1,'fixture',?)`).run(state)
    const lookup = await h.post({ protocol_version: 1,
      identity_key: 'fixture-dead-key' }, '/api/identity-key/lookup')
    expect(await lookup.json()).toEqual({ ok: false, error: 'not_found' })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await h.post(input())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false,
      error: 'managed_control_required', target_index: 1, retryable: false })
    expect(new AgentsRepo(h.db).findById(h.peer.agent_id)).toBeDefined()
    expect(JSON.stringify(logged.mock.calls)).not.toContain('fixture-dead-key')
  })

  it('validates opt-in fields before any physical probe', async () => {
    const h = await setup()
    for (const extra of [{ allow_dead_if_identity_unclaimed: true },
      { identity_key: 'fixture-dead-key', allow_dead_if_identity_unclaimed: false },
      { identity_key: 'fixture-dead-key', allow_dead_if_identity_unclaimed: true,
        opencode_session_id: 'ses_other' },
      { identity_key: 'fixture-dead-key', allow_dead_if_identity_unclaimed: true,
        pane_dead: true }]) {
      const response = await h.post({ protocol_version: 1,
        targets: [{ tmux: coordinates(2), ...extra }] })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    }
    expect(h.probes.panes).not.toHaveBeenCalled()
    expect(new AgentsRepo(h.db).findById(h.peer.agent_id)).toBeDefined()
  })

  it('keeps live-only calls and refuses respawned targets', async () => {
    const h = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ordinary = await h.post({ protocol_version: 1, targets: [{
      tmux: coordinates(2), identity_key: 'fixture-dead-key' }] })
    expect(ordinary.status).toBe(409)
    const live = await h.post({ protocol_version: 1, targets: [{
      tmux: coordinates(1), identity_key: 'fixture-live-key',
      allow_dead_if_identity_unclaimed: true }] })
    expect(live.status).toBe(409)
    expect((await live.json()).detail).toBe('dead_pane_evidence_required')
    expect(new AgentsRepo(h.db).findById(h.peer.agent_id)).toBeDefined()
  })
})
