import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { PaneReleaseService } from '../src/pane-release/service.js'
import { paneReleaseSchema, type PaneReleaseInput } from '../src/pane-release/schema.js'
import { PaneProbeError, type PaneProbes, type PaneSnapshot,
  type ProcessSnapshot } from '../src/pane-lookup/probes.js'
import { parseOpencodeAttach } from '../src/pane-release/carrier.js'
import { ReleaseSnapshots } from '../src/pane-release/snapshot.js'

const serverStart = 1793000000
const base = { socket_path: '/private/isolated/release.sock', server_pid: 400,
  server_started_at: serverStart }
const coordinates = (number: number) => ({ ...base, pane_id: `%${number}` })
const boundAt = new Date((serverStart + 20) * 1000).toISOString()

describe('exact batch pane release', () => {
  let db: ReturnType<typeof openDb>
  let agents: AgentsRepo
  let service: PaneReleaseService
  let panes: PaneSnapshot[]
  let processes: ProcessSnapshot[]
  let probes: PaneProbes
  const released = vi.fn()
  const log = vi.fn()

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    agents = new AgentsRepo(db)
    panes = [1, 2].map(number => ({ ...coordinates(number),
      pane_pid: 100 + number, tty: `pts/${number}` }))
    processes = panes.map(pane => ({ pid: pane.pane_pid, pgid: pane.pane_pid,
      tpgid: pane.pane_pid, tty: pane.tty, started_at: (serverStart + 2) * 1000,
      stat: 'S+', command: '/usr/bin/claude' }))
    probes = {
      socket: vi.fn(async () => ({ path: base.socket_path,
        device: 1, inode: 2, uid: 501 })),
      panes: vi.fn(async () => panes.map(pane => ({ ...pane }))),
      process: vi.fn(async pid => {
        const process = processes.find(process => process.pid === pid)
        return process ? { ...process } : undefined
      }),
      ttyProcesses: vi.fn(async tty => processes
        .filter(process => process.tty === tty).map(process => ({ ...process }))),
    }
    released.mockReset()
    log.mockReset()
    service = new PaneReleaseService(db, 'local', { probes, onReleased: released, log })
  })
  afterEach(() => { vi.restoreAllMocks(); db.close() })

  function seed(number: number, key: string | null = `key-${number}`) {
    const row = agents.register({ name: `worker-${number}`, team: 'project',
      device: 'local', agent_type: 'claude-code', identity_key: key ?? undefined,
      delivery: { kind: 'claude-channel', channel_session_id: `channel-${number}` } })
    db.prepare(`UPDATE agents SET tmux_pane_id=?,runtime_ui_pid=?,runtime_tty=?,
      runtime_verification_mode='verified_pid_tty_pane',runtime_bound_at=?
      WHERE agent_id=?`).run(`%${number}`, 100 + number, `pts/${number}`,
      boundAt, row.agent_id)
    return row.agent_id
  }

  function historical(number: number) {
    const id = seed(number, `retired-key-${number}`)
    db.prepare(`UPDATE agents SET runtime_ui_pid=?,runtime_tty=?,
      runtime_bound_at=? WHERE agent_id=?`).run(900 + number,
      `pts/old-${number}`, new Date((serverStart - 1000) * 1000).toISOString(), id)
    db.prepare(`INSERT INTO codex_pane_bindings(pane_id,launch_id,expires_at)
      VALUES (?,?,?)`).run(`%${number}`, `launch-${number}`, '2000-01-01T00:00:00Z')
    return id
  }
  const input = (...numbers: number[]): PaneReleaseInput => ({
    protocol_version: 1, targets: numbers.map(number => ({
      tmux: coordinates(number), identity_key: `key-${number}` })),
  })
  const count = () => (db.prepare('SELECT count(*) AS n FROM agents')
    .get() as { n: number }).n

  it('releases both verified members atomically and permits an exact repeat', async () => {
    const first = seed(1)
    const second = seed(2)
    const result = await service.release(input(1, 2))
    expect(result).toEqual({ ok: true, protocol_version: 1, results: [
      { index: 0, state: 'released', agent: { agent_id: first,
        name: 'worker-1', team: 'project', agent_type: 'claude-code' } },
      { index: 1, state: 'released', agent: { agent_id: second,
        name: 'worker-2', team: 'project', agent_type: 'claude-code' } },
    ] })
    expect(released).toHaveBeenCalledWith([first, second])
    expect(count()).toBe(0)
    expect(await service.release(input(1, 2))).toMatchObject({ ok: true, results: [
      { index: 0, state: 'already_unregistered', agent: null },
      { index: 1, state: 'already_unregistered', agent: null },
    ] })
    expect(JSON.stringify(result)).not.toContain('key-')
  })

  it('supports manual registration without a key and leaves unrelated members', async () => {
    seed(1, null)
    const sibling = seed(2)
    expect(await service.release({ protocol_version: 1,
      targets: [{ tmux: coordinates(1) }] })).toMatchObject({ ok: true,
      results: [{ state: 'released' }] })
    expect(agents.findById(sibling)).toBeDefined()
  })

  it('does not partially release when the second key moved to another pane', async () => {
    seed(1)
    const second = seed(2)
    db.prepare('UPDATE agents SET tmux_pane_id=? WHERE agent_id=?').run('%99', second)
    expect(await service.release(input(1, 2))).toMatchObject({ ok: false,
      error: 'identity_mismatch', target_index: 1 })
    expect(count()).toBe(2)
    expect(released).not.toHaveBeenCalled()
  })

  it('rejects a different registered identity rather than reporting the old key absent', async () => {
    seed(1, 'replacement-key')
    expect(await service.release(input(1))).toMatchObject({
      error: 'identity_mismatch', target_index: 0 })
    expect(count()).toBe(1)
  })

  it('requires the correct socket/server incarnation and a live pane', async () => {
    seed(1)
    expect(await service.release({ ...input(1), targets: [{
      ...input(1).targets[0], tmux: { ...coordinates(1), server_started_at: serverStart + 1 },
    }] })).toMatchObject({ error: 'pane_unverifiable' })
    panes = []
    expect(await service.release(input(1))).toMatchObject({ error: 'pane_unverifiable' })
    expect(count()).toBe(1)
  })

  it('rejects ambiguous and unverifiable carrier bindings', async () => {
    seed(1)
    const other = agents.register({ name: 'duplicate', team: 'project',
      device: 'local', agent_type: 'claude-code' })
    db.prepare(`UPDATE agents SET tmux_pane_id='%1',runtime_ui_pid=101,
      runtime_tty='pts/1',runtime_verification_mode='verified_pid_tty_pane',
      runtime_bound_at=? WHERE agent_id=?`).run(boundAt, other.agent_id)
    expect(await service.release(input(1))).toMatchObject({ error: 'ambiguous_identity' })
    expect(count()).toBe(2)
  })

  it('rejects a registration changed during any target proof', async () => {
    const first = seed(1)
    seed(2)
    let changed = false
    vi.mocked(probes.process).mockImplementation(async pid => {
      if (pid === 102 && !changed) {
        changed = true
        db.prepare('UPDATE agents SET register_generation=register_generation+1 WHERE agent_id=?')
          .run(first)
      }
      const value = processes.find(process => process.pid === pid)
      return value ? { ...value } : undefined
    })
    expect(await service.release(input(1, 2))).toMatchObject({ error: 'stale_binding' })
    expect(count()).toBe(2)
  })

  it('allows heartbeat and inbox cursor changes without treating them as ownership changes', async () => {
    const id = seed(1)
    const original = probes.process
    probes.process = async pid => {
      db.prepare('UPDATE agents SET last_seen_at=?,last_processed_event_id=9 WHERE agent_id=?')
        .run(new Date().toISOString(), id)
      return original(pid)
    }
    expect(await service.release(input(1))).toMatchObject({ ok: true })
  })

  it('requires managed identities to use their fenced release even before bind', async () => {
    seed(1)
    db.prepare(`INSERT INTO managed_claims
      (claim_id,device,name,team,agent_type,identity_key,instance_id,generation,
       token_hash,state) VALUES ('claim','local','worker-1','project',
       'claude-code','key-1','instance',1,'fixture','prepared')`).run()
    expect(await service.release(input(1))).toMatchObject({
      error: 'managed_control_required', target_index: 0 })
    expect(count()).toBe(1)
  })

  it('logs specific probe failures without exposing identity keys', async () => {
    seed(1)
    vi.mocked(probes.socket).mockRejectedValue(new PaneProbeError('socket_inspection_failed',
      new Error('permission denied for key-1')))
    expect(await service.release(input(1))).toEqual({ ok: false,
      protocol_version: 1, error: 'probe_failed', detail: 'socket_inspection_failed',
      target_index: 0, retryable: true })
    expect(JSON.stringify(log.mock.calls)).toContain('permission denied')
    expect(JSON.stringify(log.mock.calls)).not.toContain('key-1')
    expect(count()).toBe(1)
  })

  it.each(['--session', '-s'])('verifies unbound HTTP OpenCode using exact attach %s', async flag => {
    const row = agents.register({ name: 'http-opencode', team: 'project',
      device: 'local', agent_type: 'opencode', identity_key: 'key-1',
      opencode_runtime_generation: 4, delivery: { kind: 'opencode-server',
        base_url: 'http://127.0.0.1:12121', session_id: 'ses_exact', runtime_generation: 4 } })
    processes[0] = { ...processes[0],
      command: `/usr/bin/opencode attach http://127.0.0.1:12121/ ${flag} ses_exact` }
    const request = { ...input(1), targets: [{ ...input(1).targets[0],
      opencode_session_id: 'ses_exact' }] }
    expect(await service.release(request)).toMatchObject({ ok: true,
      results: [{ state: 'released', agent: { agent_id: row.agent_id } }] })
    expect(count()).toBe(0)
    expect(await service.release(request)).toMatchObject({ ok: true,
      results: [{ state: 'already_unregistered' }] })
  })

  it('rejects an OpenCode session mismatch, duplicate carriers and shared server pane reuse', async () => {
    const row = agents.register({ name: 'http', team: 'project', device: 'local',
      agent_type: 'opencode', identity_key: 'key-1', delivery: {
        kind: 'opencode-server', base_url: 'http://127.0.0.1:12121', session_id: 'ses_new' } })
    processes[0] = { ...processes[0],
      command: '/usr/bin/opencode attach http://127.0.0.1:12121 --session ses_old' }
    expect(await service.release(input(1))).toMatchObject({ error: 'pane_unverifiable' })
    processes[0].command = '/usr/bin/opencode attach http://127.0.0.1:12121 --session ses_new'
    processes.push({ ...processes[0], pid: 300, pgid: 300, tpgid: 300 })
    expect(await service.release(input(1))).toMatchObject({ error: 'ambiguous_identity' })
    expect(agents.findById(row.agent_id)).toBeDefined()
  })

  it('validates batch bounds, opaque keys and duplicate target declarations', () => {
    expect(paneReleaseSchema.safeParse({ protocol_version: 1, targets: [] }).success)
      .toBe(false)
    expect(paneReleaseSchema.safeParse(input(...Array.from({ length: 17 }, (_, i) => i))).success)
      .toBe(false)
    expect(paneReleaseSchema.safeParse(input(1, 1)).success).toBe(false)
    expect(paneReleaseSchema.safeParse({ ...input(1), unexpected: 1 }).success).toBe(false)
    const parsed = paneReleaseSchema.parse({ ...input(1), targets: [{
      tmux: coordinates(1), identity_key: ' key-1 ',
    }] })
    expect(parsed.targets[0].identity_key).toBe(' key-1 ')
    expect(parseOpencodeAttach('opencode attach http://localhost --session ses_first -s ses_other'))
      .toBeUndefined()
    expect(parseOpencodeAttach('sh -c opencode attach http://localhost --session ses_first'))
      .toBeUndefined()
  })

  it.each([true, false])('rechecks late native owners inside the transaction, prior row: %s', async exists => {
    const delivery = { kind: 'opencode-server' as const,
      base_url: 'http://127.0.0.1:12121', session_id: 'ses_exact' }
    if (exists) agents.register({ name: 'original', team: 'project', device: 'local',
      identity_key: 'key-1', agent_type: 'opencode', delivery })
    processes[0] = { ...processes[0],
      command: 'opencode attach http://127.0.0.1:12121 --session ses_exact' }
    let reads = 0
    vi.mocked(probes.panes).mockImplementation(async () => {
      reads += 1
      if (reads === 8) agents.register({ name: 'late-owner', team: 'project',
        device: 'local', agent_type: 'opencode', delivery })
      return panes.map(pane => ({ ...pane }))
    })
    expect(await service.release(input(1))).toMatchObject({ ok: false,
      error: 'stale_binding', target_index: 0 })
    expect(count()).toBe(exists ? 2 : 1)
    expect(released).not.toHaveBeenCalled()
  })

  it('rolls back all removals on a storage error and never runs post-commit cleanup', async () => {
    seed(1)
    seed(2)
    db.exec(`CREATE TRIGGER fail_fixture_delete BEFORE DELETE ON agents
      WHEN OLD.name='worker-2' BEGIN SELECT RAISE(ABORT,'fixture delete failed'); END`)
    await expect(service.release(input(1, 2))).rejects.toThrow('fixture delete failed')
    expect(count()).toBe(2)
    expect(released).not.toHaveBeenCalled()
  })

  it('redacts every batch key longest first in probe errors', async () => {
    seed(1, 'key')
    seed(2, 'key-long-secret')
    vi.mocked(probes.socket).mockRejectedValue(new PaneProbeError('socket_inspection_failed',
      new Error('denied key-long-secret and key')))
    expect(await service.release({ protocol_version: 1, targets: [
      { tmux: coordinates(1), identity_key: 'key' },
      { tmux: coordinates(2), identity_key: 'key-long-secret' },
    ] })).toMatchObject({ error: 'probe_failed' })
    expect(JSON.stringify(log.mock.calls)).toContain('denied [redacted] and [redacted]')
    expect(JSON.stringify(log.mock.calls)).not.toContain('-long-secret')
  })

  it('rejects a managed claim appearing after an unregistered-pane proof', async () => {
    let reads = 0
    vi.mocked(probes.panes).mockImplementation(async () => {
      reads += 1
      if (reads === 8) db.prepare(`INSERT INTO managed_claims
        (claim_id,device,name,team,agent_type,identity_key,instance_id,generation,
         token_hash,state) VALUES ('late-claim','local','managed','project',
         'claude-code','key-1','late-instance',1,'fixture','prepared')`).run()
      return panes.map(pane => ({ ...pane }))
    })
    expect(await service.release(input(1))).toMatchObject({ ok: false,
      error: 'managed_control_required', target_index: 0 })
    expect(released).not.toHaveBeenCalled()
  })

  it.each(['T', 'Z'])('does not label an inactive unregistered pane root %s as released', async stat => {
    processes[0] = { ...processes[0], stat }
    expect(await service.release(input(1))).toMatchObject({ ok: false,
      error: 'pane_unverifiable', target_index: 0 })
    expect(released).not.toHaveBeenCalled()
  })

  it('accepts a full 16-pane batch with independent carrier proofs', async () => {
    const numbers = Array.from({ length: 16 }, (_, index) => index + 1)
    panes = numbers.map(number => ({ ...coordinates(number),
      pane_pid: 100 + number, tty: `pts/${number}` }))
    processes = panes.map(pane => ({ pid: pane.pane_pid, pgid: pane.pane_pid,
      tpgid: pane.pane_pid, tty: pane.tty, started_at: (serverStart + 2) * 1000,
      stat: 'S+', command: '/usr/bin/claude' }))
    for (const number of numbers) seed(number)
    const result = await service.release(input(...numbers))
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.error)
    expect(result.results).toHaveLength(16)
    expect(result.results.map(item => item.index)).toEqual(numbers.map(number => number - 1))
    expect(count()).toBe(0)
  })

  it('does not claim a manual carrier unregistered when a matching identity has no location proof', async () => {
    const row = agents.register({ name: 'unlocated-manual', device: 'local',
      agent_type: 'claude-code', delivery: { kind: 'claude-channel',
        channel_session_id: 'unlocated-channel' } })
    expect(await service.release({ protocol_version: 1,
      targets: [{ tmux: coordinates(1) }] })).toMatchObject({ ok: false,
      error: 'pane_unverifiable' })
    expect(agents.findById(row.agent_id)).toBeDefined()
  })

  it('ignores an unrelated zero-PID pane even if it retains the live target TTY', async () => {
    seed(1)
    panes = [...panes, { ...panes[0], pane_id: '%88', pane_pid: 0 }]
    expect(await service.release(input(1))).toMatchObject({ ok: true,
      results: [{ state: 'released' }] })
    expect(probes.process).not.toHaveBeenCalledWith(0)
  })

  it.each([1, 2])('proves an unclaimed current pane apart from prior-server row %s', async number => {
    const retired = historical(number)
    const previous = agents.findById(retired)
    const peer = seed(number === 1 ? 2 : 1)
    const result = await service.release(input(1, 2))
    expect(result).toMatchObject({ ok: true, results: [
      { state: number === 1 ? 'already_unregistered' : 'released' },
      { state: number === 2 ? 'already_unregistered' : 'released' },
    ] })
    expect(agents.findById(retired)).toEqual(previous)
    expect(agents.findById(peer)).toBeUndefined()
    expect(released).toHaveBeenCalledWith([peer])
    expect(db.prepare('SELECT pane_id FROM codex_pane_bindings WHERE pane_id=?')
      .get(`%${number}`)).toBeDefined()
  })

  it.each(['key-holder', 'no-target-key', 'keyless-history', 'same-server',
    'unverified-history', 'live-old-pid', 'managed-history', 'empty-key', 'blank-key'])
  ('does not ignore uncertain or still-owned historical claims: %s', async reason => {
    const retired = historical(1)
    const peer = seed(2)
    let request = input(1, 2)
    if (reason === 'key-holder') {
      db.prepare('UPDATE agents SET identity_key=? WHERE agent_id=?')
        .run('key-1', retired)
    }
    if (reason === 'no-target-key') request = { ...request,
      targets: [{ tmux: coordinates(1) }, request.targets[1]] }
    if (reason === 'keyless-history') {
      db.prepare('UPDATE agents SET identity_key=NULL WHERE agent_id=?').run(retired)
    }
    if (reason === 'empty-key' || reason === 'blank-key') {
      db.prepare('UPDATE agents SET identity_key=? WHERE agent_id=?')
        .run(reason === 'empty-key' ? '' : ' ', retired)
    }
    if (reason === 'same-server') {
      db.prepare('UPDATE agents SET runtime_bound_at=? WHERE agent_id=?')
        .run(boundAt, retired)
    }
    if (reason === 'unverified-history') {
      db.prepare('UPDATE agents SET runtime_verification_mode=NULL WHERE agent_id=?')
        .run(retired)
    }
    if (reason === 'live-old-pid') processes = [...processes,
      { ...processes[0], pid: 901, tty: 'pts/old-1' }]
    if (reason === 'managed-history') db.prepare(`INSERT INTO managed_claims
      (claim_id,device,name,team,agent_type,identity_key,instance_id,generation,
       token_hash,state) VALUES ('historical','local','worker-1','project',
       'claude-code','retired-key-1','old-instance',1,'fixture','prepared')`).run()
    expect(await service.release(request)).toMatchObject({ ok: false, target_index: 0 })
    expect(agents.findById(retired)).toBeDefined()
    expect(agents.findById(peer)).toBeDefined()
    expect(released).not.toHaveBeenCalled()
  })

  it('rejects historical claim changes inside the final proof without releasing its peer', async () => {
    const retired = historical(1)
    const peer = seed(2)
    let oldPidReads = 0
    const original = probes.process
    probes.process = async pid => {
      if (pid === 901 && ++oldPidReads === 4) {
        db.prepare('UPDATE agents SET register_generation=register_generation+1 WHERE agent_id=?')
          .run(retired)
      }
      return original(pid)
    }
    expect(await service.release(input(1, 2))).toMatchObject({
      ok: false, error: 'stale_binding', target_index: 0 })
    expect(agents.findById(retired)).toBeDefined()
    expect(agents.findById(peer)).toBeDefined()
    expect(released).not.toHaveBeenCalled()
  })

  it.each(['owner', 'managed'])('rejects a late historical %s claim at commit', async kind => {
    const retired = historical(1)
    const peer = seed(2)
    const original = ReleaseSnapshots.prototype.byId
    const read = vi.spyOn(ReleaseSnapshots.prototype, 'byId')
    read.mockImplementation(function (this: ReleaseSnapshots, id: string) {
      read.mockRestore()
      if (kind === 'managed') db.prepare(`INSERT INTO managed_claims
        (claim_id,device,name,team,agent_type,identity_key,instance_id,generation,
         token_hash,state) VALUES ('late-history','local','worker-1','project',
         'claude-code','retired-key-1','old-instance',1,'fixture','prepared')`).run()
      else {
        const row = agents.register({ name: 'late-owner', device: 'local',
          agent_type: 'claude-code', identity_key: 'key-1' })
        db.prepare('UPDATE agents SET tmux_pane_id=? WHERE agent_id=?')
          .run('%1', row.agent_id)
      }
      return original.call(this, id)
    })
    expect(await service.release(input(1, 2))).toMatchObject({ ok: false,
      error: kind === 'managed' ? 'managed_control_required' : 'stale_binding',
      target_index: 0 })
    expect(agents.findById(retired)).toBeDefined()
    expect(agents.findById(peer)).toBeDefined()
    expect(released).not.toHaveBeenCalled()
  })

  it('keeps the batch intact when an old PID reappears during historical verification', async () => {
    const retired = historical(1)
    const peer = seed(2)
    const original = probes.process
    let reads = 0
    probes.process = async pid => pid === 901 && ++reads >= 4
      ? { ...processes[0], pid, tty: 'pts/old-1' } : original(pid)
    expect(await service.release(input(1, 2))).toMatchObject({ ok: false,
      error: 'pane_unverifiable', target_index: 0 })
    expect(agents.findById(retired)).toBeDefined()
    expect(agents.findById(peer)).toBeDefined()
  })

  it('retains runtime ownership when a historical OpenCode identity is attached again', async () => {
    const retired = historical(1)
    const peer = seed(2)
    db.prepare(`UPDATE agents SET agent_type='opencode',delivery_kind='opencode-server',
      delivery_payload=? WHERE agent_id=?`).run(JSON.stringify({
      base_url: 'http://127.0.0.1:12121', session_id: 'ses_retired',
    }), retired)
    processes[0] = { ...processes[0],
      command: 'opencode attach http://127.0.0.1:12121 --session ses_retired' }
    expect(await service.release(input(1, 2))).toMatchObject({ ok: false,
      error: 'identity_mismatch', target_index: 0 })
    expect(agents.findById(retired)).toBeDefined()
    expect(agents.findById(peer)).toBeDefined()
    expect(released).not.toHaveBeenCalled()
  })
})
