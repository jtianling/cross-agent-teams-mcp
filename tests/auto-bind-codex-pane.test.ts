import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import {
  autoBindCodexPane,
  detectForegroundCodexCarrierPid,
  type IdentityKeyAttachDeps,
} from '../src/mcp/auto-bind-codex-pane.js'
import type { IdentityKeyMatch } from '../src/storage/agents-repo.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-auto-bind-'))

// Real aoe launch shape: codex started through a node wrapper, so the pane
// tty hosts TWO lines matching codex --remote + uuid.  The wrapper is the
// process-group leader (pid === pgid === tpgid) and the native child shares
// the pgid; both are foreground.
const WRAPPER_LINE =
  '39074 39074 39074 Ss+ node /Users/jtianling/.nvm/versions/node/v22.11.0/'
  + 'bin/codex --remote ws://127.0.0.1:8799 -C /Users/jtianling/workspace/aoe'
  + ' -c xats.agent_id="U1"'
const NATIVE_CHILD_LINE =
  '41846 39074 39074 S+ /Users/jtianling/.local/share/codex-darwin-arm64/'
  + 'vendor/aarch64-apple-darwin/bin/codex --remote ws://127.0.0.1:8799'
  + ' -C /Users/jtianling/workspace/aoe -c xats.agent_id="U1"'

interface MockBindSvc {
  verify: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
}

// auto-bind now splits the async verification from the synchronous persist so
// the persist can share the caller's transaction; the stub mirrors that.
function makeBindSvc(result: unknown): MockBindSvc {
  const ok = typeof result === 'object' && result !== null
    && (result as { ok?: boolean }).ok === true
  return {
    verify: vi.fn().mockResolvedValue(
      ok ? { ...(result as object), expectedRegisterGeneration: 1 } : result
    ),
    commit: vi.fn().mockReturnValue({ ok: true }),
  }
}

function seedCaller(
  db: ReturnType<typeof openDb>,
  agentId: string,
  team = 'default',
  name = 'caller'
): void {
  db.prepare(
    `INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, 'local', team, 'impl', name, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
}

describe('autoBindCodexPane', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('binds and consumes on a unique match', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true, tmux_pane_id: '%10', tty: 'ttys001' })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => ['12345 12345 12345 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'],
      }
    )
    expect(ok).toBe('bound_consumed')
    expect(bindSvc.verify).toHaveBeenCalledWith({
      callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
      agent: 'codex',
      ui_pid: 12345,
    })
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(0)
  })

  it('returns false when there are zero pending pre-regs', async () => {
    seedCaller(db, 'caller-1')
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      { listPanes: async () => [], ttyProcesses: async () => [] }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
  })

  it('a row whose pane the daemon cannot see says so instead of vanishing', async () => {
    // The daemon shells out to BARE tmux, so a row for a pane on another
    // server drops out of the candidate set — and the candidate count is the
    // scan's only correlation.  Unlogged, that subtraction is invisible: the
    // log afterwards cannot tell "the row was skipped" from "the row was
    // never there", which is exactly the ambiguity that cost a production
    // investigation its afternoon.
    const log = vi.fn()
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%90', xats_agent_id: 'U9', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo, log,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      { listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }], ttyProcesses: async () => [] }
    )
    expect(ok).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      'pane=%90 reason=pane_not_visible caller=caller-1'
    ))
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('returns false on multi-match without consuming any row, and says why', async () => {
    // Two codex panes each correctly pre-registered and each hosting their own
    // carrier is the ORDINARY configuration, not an anomaly — and it makes the
    // scan fail closed, because "exactly one machine-wide candidate" is its
    // only correlation.  Failing closed is right; failing SILENTLY is not:
    // with no line of its own, the only trace was the fallback's later
    // pane_has_pending_prereg, which names a pane and hides the count that
    // actually decided it.
    const log = vi.fn()
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    repo.upsert({ pane_id: '%20', xats_agent_id: 'U2', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo, log,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [
          { pane_id: '%10', tty: 'ttys001' },
          { pane_id: '%20', tty: 'ttys002' },
        ],
        ttyProcesses: async (tty) => {
          if (tty === 'ttys001') return ['111 111 111 Ss codex --remote -c xats.agent_id="U1"']
          if (tty === 'ttys002') return ['222 222 222 Ss codex --remote -c xats.agent_id="U2"']
          return []
        },
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      'reason=candidate_count caller=caller-1 candidates=2 pending=2'
    ))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('panes=%10,%20'))
  })

  it('returns false without consuming when argv UUID does not match', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        // argv has U2, stored UUID is U1
        ttyProcesses: async () => ['111 111 111 Ss codex --remote -c xats.agent_id="U2"'],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('stopped or zombie codex lines are never auto-bind candidates', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    for (const stat of ['T', 'Z']) {
      const ok = await autoBindCodexPane(
        { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
        {
          listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
          ttyProcesses: async () => [
            `12345 12345 555 ${stat} codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"`,
            '555 555 555 S+ -zsh',
          ],
        }
      )
      expect(ok).toBe(false)
    }
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('a background codex (pgid != tpgid, foreground shell) never binds', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        // Reviewer repro: codex alive (STAT S) but backgrounded — the pane
        // tty's foreground process group belongs to the shell, so a bind
        // would aim later pastes at the shell.
        ttyProcesses: async () => [
          '12345 12345 555 S codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
          '555 555 555 S+ -zsh',
        ],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('a ps line missing the pgid/tpgid columns is rejected fail-closed', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        // Legacy pid/ppid/stat/command format: no foreground evidence.
        ttyProcesses: async () => ['12345 1 Ss codex --remote -c xats.agent_id="U1"'],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('returns false when tmux is unavailable, without throwing', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => { throw new Error('tmux: command not found') },
        ttyProcesses: async () => [],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('skips rows whose pane is missing from tmux list', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%GONE', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      { listPanes: async () => [], ttyProcesses: async () => [] }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('does not consume when bind_runtime_identity fails', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ error: 'pid_has_no_tty' })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => ['111 111 111 Ss codex --remote -c xats.agent_id="U1"'],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).toHaveBeenCalledTimes(1)
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  const PROBE_DEPS = {
    listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
    ttyProcesses: async () =>
      ['12345 12345 12345 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'],
  }

  function makeAttachDeps(
    overrides: Partial<IdentityKeyAttachDeps> = {}
  ): IdentityKeyAttachDeps & { applyPlan: ReturnType<typeof vi.fn> } {
    return {
      findCaller: () => ({ team: 'default', name: 'caller', identity_key: null }),
      findByIdentityKey: () => [],
      applyPlan: vi.fn(),
      isProcessAlive: () => false,
      log: vi.fn(),
      ...overrides,
    } as IdentityKeyAttachDeps & { applyPlan: ReturnType<typeof vi.fn> }
  }

  function holderMatch(overrides: Partial<IdentityKeyMatch> = {}): IdentityKeyMatch {
    return {
      agent_id: 'old-row',
      device: 'local',
      team: 'aoe',
      name: 'aoe-codex',
      role: 'default',
      runtime_ui_pid: 777,
      last_seen_at: '2026-01-01T00:00:00Z',
      ...overrides,
    }
  }

  it('attaches the stored identity_key to the caller row on consumption', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const attach = makeAttachDeps()
    const consumedPanes: string[] = []
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        onConsumed: paneId => { consumedPanes.push(paneId) },
      },
      PROBE_DEPS
    )
    expect(ok).toBe('bound_consumed')
    expect(consumedPanes).toEqual(['%10'])
    expect(attach.applyPlan).toHaveBeenCalledWith({ kind: 'bind' }, 'caller-1', 'K1')
    expect(repo.getByPaneId('%10')).toBeUndefined()
  })








  it('an attach failure rolls the consume back and is logged (no orphaned row)', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const attach = makeAttachDeps({
      applyPlan: vi.fn(() => { throw new Error('db locked') }),
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    // The attach shares the consume's transaction: a failing attach must take
    // the consume down with it, or the recovery row is gone forever with the
    // key attached nowhere.
    expect(ok).toBe(false)
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('auto-bind commit rolled back')
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db locked'))
    expect(log.mock.calls.join('\n')).not.toContain('K1')
  })

  it('an attach error embedding the key value is redacted in the log', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const attach = makeAttachDeps({
      applyPlan: vi.fn(() => { throw new Error('conflict binding K1') }),
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    expect(ok).toBe(false)
    const logged = log.mock.calls.join('\n')
    expect(logged).toContain('auto-bind commit rolled back')
    expect(logged).toContain('Error')
    expect(logged).toContain('[redacted]')
    expect(logged).not.toContain('K1')
  })

  it('an overwrite between the scan and the bind aborts without binding', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => {
          // Same values, refreshed expiry: a new generation lands mid-scan.
          repo.upsert({
            pane_id: '%10',
            xats_agent_id: 'U1',
            identity_key: 'K1',
            expires_at: '2999-03-01T00:00:00Z',
          })
          return ['12345 12345 12345 Ss codex --remote -c xats.agent_id="U1"']
        },
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.getByPaneId('%10')?.expires_at).toBe('2999-03-01T00:00:00Z')
  })

  it('an overwrite during the bind is not consumed, attached, or cancelled', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = {
      verify: vi.fn(async () => {
        // The launcher re-pre-registers the pane while verification is in
        // flight.
        repo.upsert({
          pane_id: '%10',
          xats_agent_id: 'U9',
          identity_key: 'K9',
          expires_at: '2999-02-01T00:00:00Z',
        })
        return {
          ok: true, tmux_pane_id: '%10', tty: 'ttys001', ui_pid: 12345,
          verification_mode: 'verified_pid_tty_pane',
          expectedRegisterGeneration: 1,
        }
      }),
      commit: vi.fn().mockReturnValue({ ok: true }),
    }
    const log = vi.fn()
    const attach = makeAttachDeps()
    const consumedPanes: string[] = []
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        onConsumed: paneId => { consumedPanes.push(paneId) },
        log,
      },
      PROBE_DEPS
    )
    // Only the pane bind actually happened: the distinct stale outcome lets
    // callers skip row-derived follow-ups (seat-follow) on this path.
    expect(ok).toBe('bound_stale')
    // The new row survives, its key never reaches the old caller, and its
    // recovery schedule is not cancelled.
    expect(repo.getByPaneId('%10')).toEqual({
      pane_id: '%10',
      xats_agent_id: 'U9',
      identity_key: 'K9',
      team: null,
      agent_name: null,
      expires_at: '2999-02-01T00:00:00Z',
    })
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(consumedPanes).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('%10'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stale'))
    const logged = log.mock.calls.join('\n')
    expect(logged).not.toContain('K1')
    expect(logged).not.toContain('K9')
  })

  it('consumption without a stored key never consults the attach deps', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const findCaller = vi.fn()
    const attach = makeAttachDeps({ findCaller })
    const consumedPanes: string[] = []
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        onConsumed: paneId => { consumedPanes.push(paneId) },
      },
      PROBE_DEPS
    )
    expect(ok).toBe('bound_consumed')
    expect(findCaller).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(consumedPanes).toEqual(['%10'])
  })

  it('an onConsumed failure does not corrupt the bind result, and is logged', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        onConsumed: () => { throw new Error('cancel failed') },
        log,
      },
      PROBE_DEPS
    )
    expect(ok).toBe('bound_consumed')
    expect(repo.getByPaneId('%10')).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stage=onConsumed'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cancel failed'))
  })

  it('collapses a wrapper+child foreground pair into one candidate', async () => {
    for (const procs of [
      [WRAPPER_LINE, NATIVE_CHILD_LINE],
      [NATIVE_CHILD_LINE, WRAPPER_LINE],
    ]) {
      seedCaller(db, 'caller-1')
      repo.upsert({
        pane_id: '%10',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        expires_at: '2999-01-01T00:00:00Z',
      })
      const bindSvc = makeBindSvc({ ok: true })
      const attach = makeAttachDeps()
      const consumedPanes: string[] = []
      const ok = await autoBindCodexPane(
        {
          callerAgentId: 'caller-1', runAtomic: fn => db.transaction(fn)(), expectedRegisterGeneration: 1,
          repo,
          bindRuntimeIdentitySvc: bindSvc as never,
          identityKeyAttach: attach,
          onConsumed: paneId => { consumedPanes.push(paneId) },
        },
        {
          listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
          ttyProcesses: async () => procs,
        }
      )
      expect(ok).toBe('bound_consumed')
      // The collapsed candidate's ui_pid is the group leader (the wrapper).
      expect(bindSvc.verify).toHaveBeenCalledWith({
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        agent: 'codex',
        ui_pid: 39074,
      })
      expect(consumedPanes).toEqual(['%10'])
      expect(attach.applyPlan).toHaveBeenCalledWith({ kind: 'bind' }, 'caller-1', 'K1')
      expect(repo.getByPaneId('%10')).toBeUndefined()
      db.prepare('DELETE FROM agents').run()
    }
  })

  it('matches spanning different process groups stay ambiguous and skip', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never, log },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => [
          '111 111 111 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
          '222 222 222 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
        ],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
    const logged = log.mock.calls.join('\n')
    expect(logged).toContain('pane=%10')
    expect(logged).toContain('reason=multi_pgid')
    expect(logged).toContain('matches=2')
    expect(logged).toContain('distinct_pgids=2')
    expect(logged).not.toContain('--remote')
    expect(logged).not.toContain('U1')
  })

  it('a same-group set without a leader line fails closed', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never, log },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        // Two children share pgid 39074 but no line has pid === pgid.
        ttyProcesses: async () => [
          NATIVE_CHILD_LINE,
          '41847 39074 39074 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
        ],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
    const logged = log.mock.calls.join('\n')
    expect(logged).toContain('reason=no_foreground_leader')
    expect(logged).toContain('matches=2')
    expect(logged).toContain('distinct_pgids=1')
  })

  it('a no-match skip logs pane and counts, never argv contents', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never, log },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => ['111 111 111 Ss codex --remote -c xats.agent_id="U2"'],
      }
    )
    expect(ok).toBe(false)
    const logged = log.mock.calls.join('\n')
    expect(logged).toContain('pane=%10')
    expect(logged).toContain('reason=no_match')
    expect(logged).toContain('matches=0')
    expect(logged).not.toContain('--remote')
    expect(logged).not.toContain('K1')
  })

  describe('detectForegroundCodexCarrierPid (fallback-bind probe)', () => {
    it('returns the unique foreground codex carrier pid (command-level match)', async () => {
      const pid = await detectForegroundCodexCarrierPid('ttys001', {
        ttyProcesses: async () => [
          '12345 12345 12345 S+ codex --remote ws://127.0.0.1:8799',
          '555 555 12345 S -zsh',
        ],
      })
      expect(pid).toBe(12345)
    })

    it('collapses a wrapper+child pair to the group leader pid', async () => {
      const pid = await detectForegroundCodexCarrierPid('ttys001', {
        ttyProcesses: async () => [WRAPPER_LINE, NATIVE_CHILD_LINE],
      })
      expect(pid).toBe(39074)
    })

    it('finds no carrier for a backgrounded codex or a bare shell', async () => {
      expect(
        await detectForegroundCodexCarrierPid('ttys001', {
          ttyProcesses: async () => [
            '12345 12345 555 S codex --remote ws://127.0.0.1:8799',
            '555 555 555 S+ -zsh',
          ],
        })
      ).toBeUndefined()
      expect(
        await detectForegroundCodexCarrierPid('ttys001', {
          ttyProcesses: async () => ['555 555 555 S+ -zsh'],
        })
      ).toBeUndefined()
    })

    it('reads a probe failure as no carrier', async () => {
      expect(
        await detectForegroundCodexCarrierPid('ttys001', {
          ttyProcesses: async () => { throw new Error('ps unavailable') },
        })
      ).toBeUndefined()
    })
  })

  it('GCs expired rows before scanning', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%EXPIRED', xats_agent_id: 'OLD', expires_at: '2000-01-01T00:00:00Z' })
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    await autoBindCodexPane(
      { callerAgentId: 'caller-1', expectedRegisterGeneration: 1, repo,
        runAtomic: fn => db.transaction(fn)(), bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => ['111 111 111 Ss codex --remote -c xats.agent_id="U1"'],
        now: () => new Date('2026-01-01T00:00:00Z'),
      }
    )
    // Both the expired row (GC) and the matched row (consumed) should be gone.
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(0)
  })
})
