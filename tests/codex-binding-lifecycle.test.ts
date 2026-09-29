import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexBindingRepo } from '../src/mcp/codex-binding-repo.js'
import { CodexBindingLookup } from '../src/mcp/codex-binding-lookup.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import { autoBindCodexPane } from '../src/mcp/auto-bind-codex-pane.js'
import { BindRuntimeIdentityService } from '../src/mcp/bind-runtime-identity.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  execFileSync: vi.fn(() => { throw new Error('Unexpected subprocess') }),
  spawn: vi.fn(() => { throw new Error('Unexpected subprocess') }),
}))

const LAUNCH = '11111111-1111-4111-8111-111111111111'
const NEXT = '22222222-2222-4222-8222-222222222222'
const THREAD = '33333333-3333-4333-8333-333333333333'
const EXPIRES = '2999-01-01T00:00:00.000Z'
const input = { protocol_version: 1 as const, pane_id: '%22', launch_id: LAUNCH }
const line = (pid = 123, launch = LAUNCH, pgid = pid) =>
  `${pid} ${pgid} ${pgid} S+ codex --remote -c xats.agent_id="${launch}"`

describe('exact Codex launch binding lifecycle', () => {
  let db: ReturnType<typeof openDb>
  let repo: CodexBindingRepo
  let pre: CodexPanePreRegRepo
  let bind: BindRuntimeIdentityService
  let lookup: CodexBindingLookup
  let listPanes: ReturnType<typeof vi.fn>
  let ttyProcesses: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    repo = new CodexBindingRepo(db)
    pre = new CodexPanePreRegRepo(db)
    bind = new BindRuntimeIdentityService(db)
    db.prepare(
      `INSERT INTO agents (agent_id, device, team, role, name,
         registered_at, last_seen_at, register_generation,
         delivery_kind, delivery_payload)
       VALUES ('a', 'local', 'team', 'default', 'main', '', '', 1,
         'codex-appserver', ?)`
    ).run(JSON.stringify({ thread_id: THREAD }))
    vi.spyOn(bind, 'verify').mockResolvedValue({
      ok: true, tmux_pane_id: '%22', tty: 'ttys022', ui_pid: 123,
      verification_mode: 'verified_pid_tty_pane', expectedRegisterGeneration: 1,
    })
    listPanes = vi.fn(async () => [{ pane_id: '%22', tty: 'ttys022' }])
    ttyProcesses = vi.fn(async () => [line(), line(124, LAUNCH, 123)])
    lookup = new CodexBindingLookup(repo, 'local', { listPanes, ttyProcesses })
    announce()
  })

  afterEach(() => { db.close(); vi.restoreAllMocks() })

  function announce(launch = LAUNCH, expiresAt = EXPIRES): void {
    pre.upsert({ pane_id: '%22', xats_agent_id: launch, expires_at: expiresAt })
  }

  function complete(exact = true) {
    return autoBindCodexPane({
      callerAgentId: 'a', repo: pre, bindRuntimeIdentitySvc: bind,
      expectedRegisterGeneration: 1, requirePaneNonce: true,
      targetPaneId: exact ? '%22' : undefined,
      targetPaneFromNonce: exact,
      runAtomic: fn => db.transaction(fn)(),
    }, { listPanes, ttyProcesses })
  }

  it('stays pending for an unregistered launch without probing any host', async () => {
    db.prepare('DELETE FROM agents').run()
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'pending' })
    expect(listPanes).not.toHaveBeenCalled()
  })

  it('does not consume a single candidate without pane association proof', async () => {
    expect(await complete(false)).toBe(false)
    expect(pre.getByPaneId('%22')).toBeDefined()
    expect(repo.read('%22')?.thread_id).toBeNull()
    expect(bind.verify).not.toHaveBeenCalled()
  })

  it('commits exact proof atomically and returns the wrapper/native group thread',
    async () => {
      expect(await complete()).toBe('bound_consumed')
      expect(pre.getByPaneId('%22')).toBeUndefined()
      expect(await lookup.lookup(input)).toEqual({
        ok: true, ...input, thread_id: THREAD,
      })
      const before = db.prepare('SELECT * FROM codex_pane_bindings').all()
      await lookup.lookup(input)
      expect(db.prepare('SELECT * FROM codex_pane_bindings').all()).toEqual(before)
      applySchema(db)
      expect(await lookup.lookup(input)).toMatchObject({ ok: true })
    })

  it('invalidates the old launch immediately and never leaks its thread', async () => {
    await complete()
    announce(NEXT)
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'stale' })
    expect(await lookup.lookup({ ...input, launch_id: NEXT })).toEqual({
      ok: false, error: 'pending',
    })
  })

  it('does not restore an old result after expiry cleanup', async () => {
    await complete()
    announce(NEXT, '2000-01-01T00:00:00.000Z')
    pre.deleteExpired(new Date().toISOString())
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'stale' })
    expect(await lookup.lookup({ ...input, launch_id: NEXT })).toEqual({
      ok: false, error: 'stale',
    })
  })

  it('rejects a new launch during binding verification', async () => {
    const original = await bind.verify({
      callerAgentId: 'a', agent: 'codex', expectedRegisterGeneration: 1,
    })
    vi.mocked(bind.verify).mockImplementation(async () => {
      announce(NEXT)
      return original
    })
    expect(await complete()).toBe('bound_stale')
    expect(repo.read('%22')).toMatchObject({ launch_id: NEXT, thread_id: null })
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'stale' })
  })

  it('rolls back runtime and pre-registration consumption if proof storage fails',
    async () => {
      vi.spyOn(pre, 'completeBinding').mockImplementation(() => {
        throw new Error('Storage unavailable')
      })
      expect(await complete()).toBe(false)
      expect(pre.getByPaneId('%22')).toBeDefined()
      expect(repo.read('%22')?.thread_id).toBeNull()
      expect(db.prepare('SELECT tmux_pane_id FROM agents').get()).toEqual({
        tmux_pane_id: null,
      })
    })

  it('does not publish failed or superseded registration bindings', async () => {
    db.prepare('UPDATE agents SET register_generation = 2').run()
    expect(await complete()).toBe(false)
    expect(repo.read('%22')?.thread_id).toBeNull()
  })

  it.each([
    'DELETE FROM agents',
    "UPDATE agents SET tmux_pane_id = '%23'",
    'UPDATE agents SET runtime_ui_pid = 456',
    "UPDATE agents SET delivery_payload = '{\"thread_id\":\"other\"}'",
    "UPDATE agents SET device = 'remote'",
  ])('rejects stale agent state: %s', async sql => {
    await complete()
    db.prepare(sql).run()
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'stale' })
  })

  it.each([
    { lines: [] },
    { lines: [line(123, NEXT)] },
    { lines: [line(456)] },
    { lines: ['123 123 999 S codex --remote -c xats.agent_id="' + LAUNCH + '"'] },
  ])('rejects replaced or absent carrier: $lines', async ({ lines }) => {
    await complete()
    ttyProcesses.mockResolvedValue(lines)
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'stale' })
  })

  it('rejects carrier ambiguity and reused launch ids', async () => {
    await complete()
    ttyProcesses.mockResolvedValue([line(), line(456)])
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'ambiguous' })
    pre.upsert({ pane_id: '%23', xats_agent_id: LAUNCH, expires_at: EXPIRES })
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'ambiguous' })
  })

  it('rechecks generation after asynchronous live probing', async () => {
    await complete()
    ttyProcesses.mockImplementation(async () => { announce(NEXT); return [line()] })
    expect(await lookup.lookup(input)).toEqual({ ok: false, error: 'stale' })
  })

  it('surfaces probe errors without a successful snapshot', async () => {
    await complete()
    listPanes.mockRejectedValue(new Error('Probe failed'))
    await expect(lookup.lookup(input)).rejects.toThrow('Probe failed')
  })
})
