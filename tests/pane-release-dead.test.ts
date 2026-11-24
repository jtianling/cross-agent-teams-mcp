import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { PaneReleaseService } from '../src/pane-release/service.js'
import { paneReleaseSchema } from '../src/pane-release/schema.js'
import type { PaneProbes, PaneSnapshot, ProcessSnapshot }
  from '../src/pane-lookup/probes.js'

const serverStart = 1794566104
const base = { socket_path: '/private/fixture/dead-release.sock',
  server_pid: 400, server_started_at: serverStart }
const tmux = (pane: number) => ({ ...base, pane_id: `%${pane}` })
const request = () => ({ protocol_version: 1 as const, targets: [
  { tmux: tmux(1), identity_key: 'live-key' },
  { tmux: tmux(2), identity_key: 'dead-key',
    allow_dead_if_identity_unclaimed: true as const },
] })

describe('opt-in dead pane key absence in the original atomic batch', () => {
  let db: ReturnType<typeof openDb>
  let agents: AgentsRepo
  let service: PaneReleaseService
  let panes: Array<PaneSnapshot & { dead: boolean }>
  let processes: ProcessSnapshot[]
  let probes: PaneProbes
  let peer: string
  const released = vi.fn()

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    agents = new AgentsRepo(db)
    panes = [
      { ...tmux(1), pane_pid: 101, tty: 'pts/1', dead: false },
      { ...tmux(2), pane_pid: 0, tty: '', dead: true },
    ]
    processes = [{ pid: 101, pgid: 101, tpgid: 101, tty: 'pts/1', stat: 'S+',
      started_at: (serverStart + 2) * 1000, command: '/usr/bin/claude' }]
    probes = {
      socket: vi.fn(async () => ({ path: base.socket_path,
        device: 1, inode: 2, uid: 501 })),
      panes: vi.fn(async () => panes.map(pane => ({ ...pane }))),
      process: vi.fn(async pid => processes.find(item => item.pid === pid)),
      ttyProcesses: vi.fn(async tty => processes.filter(item => item.tty === tty)),
    }
    peer = agents.register({ name: 'peer', team: 'project', device: 'local',
      agent_type: 'claude-code', identity_key: 'live-key' }).agent_id
    db.prepare(`UPDATE agents SET tmux_pane_id='%1',runtime_ui_pid=101,
      runtime_tty='pts/1',runtime_verification_mode='verified_pid_tty_pane',
      runtime_bound_at=? WHERE agent_id=?`)
      .run(new Date((serverStart + 20) * 1000).toISOString(), peer)
    released.mockReset()
    service = new PaneReleaseService(db, 'local', { probes,
      onReleased: released, log: vi.fn() })
  })
  afterEach(() => { vi.restoreAllMocks(); db.close() })

  function managed(key = 'dead-key', state = 'prepared') {
    db.prepare(`INSERT INTO managed_claims
      (claim_id,device,name,team,agent_type,identity_key,instance_id,generation,
       token_hash,state) VALUES ('claim','local','managed','project','codex',
       ?,'managed-instance',1,'fixture',?)`).run(key, state)
  }

  function migrated() {
    const id = agents.register({ name: 'moved', team: 'project', device: 'local',
      agent_type: 'codex', identity_key: 'other-key', delivery: {
        kind: 'codex-appserver', ws_url: 'ws://127.0.0.1:8799',
        thread_id: 'new-thread' } }).agent_id
    db.prepare('UPDATE agents SET tmux_pane_id=?,runtime_ui_pid=? WHERE agent_id=?')
      .run('%99', 999, id)
    db.prepare(`INSERT INTO codex_pane_bindings
      (pane_id,launch_id,expires_at,agent_id,thread_id,runtime_ui_pid,runtime_tty)
      VALUES ('%2','old-launch','2000-01-01T00:00:00Z',?,'old-thread',202,'pts/old')`)
      .run(id)
    return id
  }

  function beforeCommit(change: () => void) {
    const original = db.transaction.bind(db)
    const hook = vi.spyOn(db, 'transaction')
    hook.mockImplementation(((fn: () => unknown) => {
      hook.mockRestore()
      change()
      return original(fn)
    }) as typeof db.transaction)
  }

  it('returns ordered absence and releases only its verified peer', async () => {
    const input = request()
    expect(paneReleaseSchema.safeParse(input).success).toBe(true)
    expect(await service.release(input)).toEqual({ ok: true, protocol_version: 1,
      results: [{ index: 0, state: 'released', agent: {
        agent_id: peer, name: 'peer', team: 'project', agent_type: 'claude-code',
      } }, { index: 1, state: 'dead_key_unclaimed', agent: null }] })
    expect(agents.findById(peer)).toBeUndefined()
    expect(released).toHaveBeenCalledWith([peer])
    expect(probes.process).not.toHaveBeenCalledWith(0)
  })

  it('preserves migrated bindings and unrelated logical/managed owners', async () => {
    const id = migrated()
    const previous = agents.findById(id)
    const binding = db.prepare('SELECT * FROM codex_pane_bindings').all()
    managed('unrelated-managed-key', 'bound')
    const logical = agents.register({ name: 'unlocated', device: 'local',
      agent_type: 'codex', delivery: { kind: 'codex-appserver',
        ws_url: 'ws://127.0.0.1:8799', thread_id: 'unlocated-thread' } })
    expect(await service.release(request())).toMatchObject({ ok: true,
      results: [{ state: 'released' }, { state: 'dead_key_unclaimed' }] })
    expect(agents.findById(id)).toEqual(previous)
    expect(agents.findById(logical.agent_id)).toBeDefined()
    expect(db.prepare('SELECT * FROM codex_pane_bindings').all()).toEqual(binding)
    expect(db.prepare('SELECT state FROM managed_claims').get())
      .toEqual({ state: 'bound' })
  })

  it.each(['prepared', 'bound'])('rejects a %s claim without a row', async state => {
    managed('dead-key', state)
    expect(await service.release(request())).toMatchObject({ ok: false,
      error: 'managed_control_required', target_index: 1 })
    expect(agents.findById(peer)).toBeDefined()
    expect(released).not.toHaveBeenCalled()
  })

  it.each(['agent', 'proxy', 'pane-owner'])('rejects a %s claim', async kind => {
    const row = agents.register({ name: 'holder', device: 'local',
      role: kind === 'proxy' ? '__channel_proxy__' : 'default',
      identity_key: kind === 'pane-owner' ? 'other-key' : 'dead-key' })
    if (kind === 'pane-owner') {
      db.prepare('UPDATE agents SET tmux_pane_id=? WHERE agent_id=?')
        .run('%2', row.agent_id)
    }
    expect(await service.release(request()))
      .toMatchObject({ ok: false, target_index: 1 })
    expect(agents.findById(peer)).toBeDefined()
    expect(agents.findById(row.agent_id)).toBeDefined()
  })

  it.each(['live', 'unknown-dead', 'nonempty-tty', 'positive-pid'])
  ('requires positive, exact dead evidence: %s', async kind => {
    panes[1] = { ...panes[1], ...(kind === 'live' ? { dead: false } : {}),
      ...(kind === 'unknown-dead' ? { dead: undefined as unknown as boolean } : {}),
      ...(kind === 'nonempty-tty' ? { tty: '?' } : {}),
      ...(kind === 'positive-pid' ? { pane_pid: 202 } : {}) }
    expect(await service.release(request())).toMatchObject({ ok: false,
      error: 'pane_unverifiable', target_index: 1 })
    expect(agents.findById(peer)).toBeDefined()
  })

  it.each(['managed', 'key-holder', 'pane-owner', 'binding', 'moved-owner'])
  ('keeps the entire batch intact on a late %s change', async kind => {
    const id = migrated()
    beforeCommit(() => {
      if (kind === 'managed') managed()
      if (kind === 'key-holder') agents.register({ name: 'late', device: 'local',
        identity_key: 'dead-key' })
      if (kind === 'pane-owner') {
        db.prepare('UPDATE agents SET tmux_pane_id=? WHERE agent_id=?').run('%2', id)
      }
      if (kind === 'binding') db.prepare('UPDATE codex_pane_bindings SET launch_id=?')
        .run('replacement-launch')
      if (kind === 'moved-owner') db.prepare(`UPDATE agents SET
        register_generation=register_generation+1 WHERE agent_id=?`).run(id)
    })
    expect(await service.release(request()))
      .toMatchObject({ ok: false, target_index: 1 })
    expect(agents.findById(peer)).toBeDefined()
    expect(agents.findById(id)).toBeDefined()
    expect(released).not.toHaveBeenCalled()
  })

  it('rejects malformed opt-in and ordinary dead targets', async () => {
    for (const extra of [{ allow_dead_if_identity_unclaimed: true },
      { identity_key: ' ', allow_dead_if_identity_unclaimed: true },
      { identity_key: 'dead-key', allow_dead_if_identity_unclaimed: true,
        opencode_session_id: 'ses_other' },
      { identity_key: 'dead-key', allow_dead_if_identity_unclaimed: false }]) {
      expect(paneReleaseSchema.safeParse({ protocol_version: 1,
        targets: [{ tmux: tmux(2), ...extra }] }).success).toBe(false)
    }
    expect(await service.release({ protocol_version: 1,
      targets: [{ tmux: tmux(2), identity_key: 'dead-key' }] }))
      .toMatchObject({ ok: false, error: 'pane_unverifiable' })
    expect(agents.findById(peer)).toBeDefined()
  })

  it.each(['active', 'invalid', 'expired'])('checks %s pending rows', async kind => {
    db.prepare(`INSERT INTO codex_pane_pre_registrations
      (pane_id,xats_agent_id,expires_at,identity_key)
      VALUES ('%2','launch',?,'dead-key')`)
      .run(kind === 'active' ? '2999-01-01T00:00:00Z'
        : kind === 'expired' ? '2000-01-01T00:00:00Z' : 'invalid')
    const result = await service.release(request())
    expect(result.ok).toBe(kind === 'expired')
    expect(db.prepare('SELECT pane_id FROM codex_pane_pre_registrations').all())
      .toHaveLength(1)
    if (kind !== 'expired') expect(agents.findById(peer)).toBeDefined()
  })

  it.each(['unlocated', 'same-pane', 'live-old-pid', 'invalid-old-pid'])
  ('refuses unresolved completed binding evidence: %s', async kind => {
    const id = migrated()
    if (kind === 'unlocated' || kind === 'same-pane') {
      db.prepare('UPDATE agents SET tmux_pane_id=? WHERE agent_id=?')
        .run(kind === 'unlocated' ? null : '%2', id)
    }
    if (kind === 'live-old-pid') processes = [...processes,
      { ...processes[0], pid: 202, tty: 'pts/old' }]
    if (kind === 'invalid-old-pid') {
      db.prepare('UPDATE codex_pane_bindings SET runtime_ui_pid=0').run()
    }
    expect(await service.release(request()))
      .toMatchObject({ ok: false, target_index: 1 })
    expect(agents.findById(peer)).toBeDefined()
    expect(agents.findById(id)).toBeDefined()
    expect(probes.process).not.toHaveBeenCalledWith(0)
  })

  it('rejects an orphan binding whose managed claim still exists', async () => {
    const id = migrated()
    db.prepare('DELETE FROM agents WHERE agent_id=?').run(id)
    managed('other-key', 'bound')
    db.prepare('UPDATE managed_claims SET agent_id=?').run(id)
    expect(await service.release(request())).toMatchObject({ ok: false,
      error: 'managed_control_required', target_index: 1 })
    expect(agents.findById(peer)).toBeDefined()
  })

  it.each(['respawn', 'socket', 'server'])('rejects changed %s', async kind => {
    let reads = 0
    vi.mocked(probes.panes).mockImplementation(async () => {
      if (++reads === 2) {
        if (kind === 'respawn') panes[1] = { ...panes[1],
          pane_pid: 202, tty: 'pts/2', dead: false }
        if (kind === 'server') panes = panes.map(pane => ({ ...pane,
          server_started_at: serverStart + 1 }))
        if (kind === 'socket') vi.mocked(probes.socket).mockResolvedValue({
          path: base.socket_path, device: 1, inode: 3, uid: 501 })
      }
      return panes.map(pane => ({ ...pane }))
    })
    expect(await service.release(request())).toMatchObject({ ok: false })
    expect(agents.findById(peer)).toBeDefined()
    expect(released).not.toHaveBeenCalled()
  })

  it('rejects a pending launch appearing after both proofs', async () => {
    beforeCommit(() => db.prepare(`INSERT INTO codex_pane_pre_registrations
      (pane_id,xats_agent_id,expires_at,identity_key)
      VALUES ('%2','new-launch','2999-01-01T00:00:00Z','dead-key')`).run())
    expect(await service.release(request())).toMatchObject({ ok: false,
      error: 'stale_binding', target_index: 1 })
    expect(agents.findById(peer)).toBeDefined()
  })

  it('cleans old bindings of explicitly released live peers', async () => {
    db.prepare(`INSERT INTO codex_pane_bindings
      (pane_id,launch_id,expires_at,agent_id,thread_id,runtime_ui_pid,runtime_tty)
      VALUES ('%2','old-launch','2000-01-01T00:00:00Z',?,'old-thread',202,'pts/old')`)
      .run(peer)
    expect(await service.release(request())).toMatchObject({ ok: true,
      results: [{ state: 'released' }, { state: 'dead_key_unclaimed' }] })
    expect(db.prepare('SELECT * FROM codex_pane_bindings').all()).toHaveLength(0)
  })

  it('rolls back peer removal and performs no cleanup if storage fails', async () => {
    const id = migrated()
    const binding = db.prepare('SELECT * FROM codex_pane_bindings').all()
    panes = [...panes, { ...tmux(3), pane_pid: 103, tty: 'pts/3', dead: false }]
    processes = [...processes, { ...processes[0], pid: 103, pgid: 103,
      tpgid: 103, tty: 'pts/3' }]
    const second = agents.register({ name: 'second-peer', device: 'local',
      agent_type: 'claude-code', identity_key: 'second-key' }).agent_id
    db.prepare(`UPDATE agents SET tmux_pane_id='%3',runtime_ui_pid=103,
      runtime_tty='pts/3',runtime_verification_mode='verified_pid_tty_pane',
      runtime_bound_at=? WHERE agent_id=?`)
      .run(new Date((serverStart + 20) * 1000).toISOString(), second)
    db.exec(`CREATE TRIGGER fail_peer BEFORE DELETE ON agents
      WHEN OLD.name='second-peer'
      BEGIN SELECT RAISE(ABORT,'fixture delete failed'); END`)
    const input = request()
    await expect(service.release({ ...input, targets: [...input.targets,
      { tmux: tmux(3), identity_key: 'second-key' }] }))
      .rejects.toThrow('fixture delete failed')
    expect(agents.findById(peer)).toBeDefined()
    expect(agents.findById(second)).toBeDefined()
    expect(agents.findById(id)).toBeDefined()
    expect(db.prepare('SELECT * FROM codex_pane_bindings').all()).toEqual(binding)
    expect(released).not.toHaveBeenCalled()
  })

  it('repeats a dead-only batch with an explicit absence state', async () => {
    managed('dead-key', 'released')
    const input = { protocol_version: 1 as const, targets: [request().targets[1]] }
    expect(await service.release(input)).toEqual({ ok: true, protocol_version: 1,
      results: [{ index: 0, state: 'dead_key_unclaimed', agent: null }] })
    expect(await service.release(input)).toMatchObject({ ok: true,
      results: [{ state: 'dead_key_unclaimed' }] })
    expect(agents.findById(peer)).toBeDefined()
  })
})
