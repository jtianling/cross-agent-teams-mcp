import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import {
  __peekCodexRecoveryGenerations,
  __peekCodexRecoverySchedules,
  buildCodexRecoveryPokeContent,
  cancelCodexRecoverySchedule,
  clearAllCodexRecoverySchedules,
  evaluateCodexRecoveryOnPreRegister,
  type CodexRecoveryDeps,
} from '../src/mcp/codex-recovery-poke.js'
import { __peekRetryMap, clearAllRetries } from '../src/mcp/poke-retry.js'
import type { IdentityKeyMatch } from '../src/storage/agents-repo.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-recovery-'))

const HOLDER: IdentityKeyMatch = {
  agent_id: 'holder-1',
  device: 'local',
  team: 'aoe',
  name: 'aoe-codex',
  role: 'default',
  runtime_ui_pid: 4242,
  last_seen_at: '2026-01-01T00:00:00.000Z',
}

const CODEX_LINE =
  '91131 91131 91131 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const SHELL_LINE = '555 555 555 Ss -zsh'
// Reviewer repro lines: SIGSTOP-ed codex (STAT T) with the shell foreground.
const STOPPED_CODEX_LINE =
  '91131 91131 555 T codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const ZOMBIE_CODEX_LINE =
  '91131 91131 91131 Z codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const SHELL_FG_TTY_LINE = '555 555 555 S+ -zsh'
// Foreground-probe format: pid pgid tpgid stat command.
const FG_CODEX_LINE =
  '91131 91131 91131 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const FG_SHELL_LINE = '555 555 555 S+ -zsh'
// W1 repro: a live codex (STAT S) whose process group is not the tty's
// foreground group — bg'd, with the shell owning the foreground.
const BG_CODEX_LINE =
  '91131 91131 555 S codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
// Real aoe launch shape: codex started through a node wrapper, so the tty
// hosts TWO lines matching codex --remote + uuid.  The wrapper is the
// process-group leader (pid === pgid === tpgid); the native child shares
// the pgid; both are foreground.
const WRAPPER_CODEX_LINE =
  '39074 39074 39074 Ss+ node /Users/jtianling/.nvm/versions/node/v22.11.0/'
  + 'bin/codex --remote ws://127.0.0.1:8799 -C /Users/jtianling/workspace/aoe'
  + ' -c xats.agent_id="U1"'
const NATIVE_CHILD_CODEX_LINE =
  '41846 39074 39074 S+ /Users/jtianling/.local/share/codex-darwin-arm64/'
  + 'vendor/aarch64-apple-darwin/bin/codex --remote ws://127.0.0.1:8799'
  + ' -C /Users/jtianling/workspace/aoe -c xats.agent_id="U1"'

interface DepsOverrides extends Partial<CodexRecoveryDeps> {}

describe('codex recovery poke', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    vi.useFakeTimers()
    clearAllCodexRecoverySchedules()
    clearAllRetries()
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    clearAllCodexRecoverySchedules()
    clearAllRetries()
    vi.useRealTimers()
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function seedRow(identityKey: string | null = 'K1'): void {
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: identityKey ?? undefined,
      expires_at: '2999-01-01T00:00:00.000Z',
    })
  }

  function makeDeps(overrides: DepsOverrides = {}): CodexRecoveryDeps {
    return {
      repo,
      findByIdentityKey: () => [HOLDER],
      localDevice: 'local',
      isProcessAlive: () => false,
      listPanes: async () => [{ pane_id: '%1972', tty: 'ttys001' }],
      ttyProcesses: async () => [CODEX_LINE],
      // Always injected: the default seam would exec real ps.
      foregroundProbeSync: () => [FG_CODEX_LINE],
      now: () => new Date('2026-01-01T00:00:10.000Z'),
      probeIntervalMs: 1_000,
      tmuxPoke: vi.fn(async () => ({
        ok: true as const,
        pane_tail_before: '',
        pane_tail_after: '',
      })),
      verifyPaneHost: vi.fn(async () => ({ ok: true as const })),
      paneGuard: vi.fn(async () => 'pass' as const),
      log: vi.fn(),
      ...overrides,
    }
  }

  function evaluate(deps: CodexRecoveryDeps, identityKey: string | null = 'K1'): void {
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: identityKey,
        expires_at: '2999-01-01T00:00:00.000Z',
      },
      deps
    )
  }

  it('template names the identity and the register_agent call, never the key', () => {
    const content = buildCodexRecoveryPokeContent({ team: 'aoe', name: 'aoe-codex' })
    expect(content).toContain('cross-agent-teams recovery notice')
    expect(content).toContain('name="aoe-codex"')
    expect(content).toContain('team="aoe"')
    expect(content).toContain('register_agent')
    expect(content).toContain('agent_type: "codex"')
    expect(content).toContain('$CODEX_THREAD_ID')
  })

  it('schedules nothing without an identity_key', () => {
    seedRow(null)
    const deps = makeDeps()
    evaluate(deps, null)
    expect(__peekCodexRecoverySchedules()).toEqual([])
  })

  it('schedules nothing on a key miss', () => {
    seedRow()
    const deps = makeDeps({ findByIdentityKey: () => [] })
    evaluate(deps)
    expect(__peekCodexRecoverySchedules()).toEqual([])
  })

  it('skips scheduling when the holder process is alive, with a debug log', () => {
    seedRow()
    const log = vi.fn()
    const deps = makeDeps({ isProcessAlive: () => true, log })
    evaluate(deps)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('alive'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('aoe-codex'))
  })

  it('does not send while the pane still runs a shell', async () => {
    seedRow()
    const deps = makeDeps({
      ttyProcesses: async () => [SHELL_LINE],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
  })

  it('detection unlocks the first send: guard, then re-checks, then paste', async () => {
    seedRow()
    const deps = makeDeps()
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.paneGuard).toHaveBeenCalledWith('%1972')
    expect(deps.verifyPaneHost).toHaveBeenCalledWith(expect.objectContaining({
      paneId: '%1972',
      pid: 91131,
      holderAgentId: 'holder-1',
    }))
    expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
    const guardOrder =
      (deps.paneGuard as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const pokeOrder =
      (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(guardOrder).toBeLessThan(pokeOrder)
    const call = (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      pane_id: string
      content: string
      skipGuard?: boolean
    }
    expect(call.pane_id).toBe('%1972')
    // The guard already ran in this send path; the primitive must not re-guard.
    expect(call.skipGuard).toBe(true)
    expect(call.content).toContain('aoe-codex')
    expect(call.content).toContain('team="aoe"')
    expect(call.content).toContain('$CODEX_THREAD_ID')
    expect(call.content).not.toContain('K1')
    expect(__peekCodexRecoverySchedules()).toEqual([])
  })

  it('a codex exit during the quiet guard cancels the send', async () => {
    seedRow()
    let procsCalls = 0
    const deps = makeDeps({
      ttyProcesses: async () => {
        procsCalls += 1
        // First probe sees codex; the post-guard re-probe sees a bare shell.
        return procsCalls === 1 ? [CODEX_LINE] : [SHELL_LINE]
      },
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('codex_process_gone')
    )
  })

  it('a codex restart under a new pid during the guard cancels the send', async () => {
    seedRow()
    let procsCalls = 0
    const restarted =
      '92000 92000 92000 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
    const deps = makeDeps({
      ttyProcesses: async () => {
        procsCalls += 1
        return procsCalls === 1 ? [CODEX_LINE] : [restarted]
      },
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('codex_pid_changed')
    )
  })

  it('a same-value overwrite during the guard is caught before pasting', async () => {
    seedRow()
    const deps = makeDeps({
      paneGuard: vi.fn(async () => {
        // Identical uuid/key, refreshed expiry: a new generation.
        repo.upsert({
          pane_id: '%1972',
          xats_agent_id: 'U1',
          identity_key: 'K1',
          expires_at: '2999-06-01T00:00:00.000Z',
        })
        return 'pass' as const
      }),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('row_stale'))
  })

  it('holder drift on a probe iteration cancels the schedule', async () => {
    seedRow()
    let lookups = 0
    const deps = makeDeps({
      findByIdentityKey: () => {
        lookups += 1
        return lookups === 1 ? [HOLDER] : [{ ...HOLDER, agent_id: 'other-row' }]
      },
      ttyProcesses: async () => [SHELL_LINE],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('holder_changed')
    )
  })

  it('a holder back alive before any send cancels the schedule', async () => {
    seedRow()
    let aliveNow = false
    const deps = makeDeps({
      isProcessAlive: () => aliveNow,
      ttyProcesses: async () => [SHELL_LINE],
    })
    evaluate(deps)
    aliveNow = true
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('holder_alive')
    )
  })

  it('a failed pane-host verification blocks the send', async () => {
    seedRow()
    const deps = makeDeps({
      verifyPaneHost: vi.fn(async () => ({
        ok: false as const,
        reason: 'pane_reassigned' as const,
      })),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('pane_reassigned')
    )
  })

  it('a first-send guard failure resumes probe polling, then delivers', async () => {
    seedRow()
    let guardCalls = 0
    const pasted: string[] = []
    const deps = makeDeps({
      paneGuard: vi.fn(async () => {
        guardCalls += 1
        return guardCalls === 1 ? 'fail' as const : 'pass' as const
      }),
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    // Guard failed: nothing pasted, no poke-retry ladder entry ever, and
    // the schedule is back in the polling loop with the same generation.
    expect(pasted).toEqual([])
    expect(__peekRetryMap().size).toBe(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    const genId = __peekCodexRecoveryGenerations().get('%1972')
    expect(genId).toBeDefined()
    // The next probe iteration (one probe interval, not 30s) re-runs the
    // FULL sequence — detect, guard, carrier, paste — and delivers once.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.paneGuard).toHaveBeenCalledTimes(2)
    expect(pasted).toHaveLength(1)
    // The failed-guard iteration never reached the primitive: the delivery
    // is the only tmuxPoke call, with the guard already consumed.
    const call = (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      skipGuard?: boolean
    }
    expect(call.skipGuard).toBe(true)
    expect(__peekRetryMap().size).toBe(0)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('terminal send errors retire the generation without resuming polling', async () => {
    seedRow()
    const deps = makeDeps({
      tmuxPoke: vi.fn(async () => ({ error: 'pane_dead' })),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('pane_dead'))
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
    expect(__peekRetryMap().size).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
  })

  it('a resumed attempt re-checks the row snapshot before pasting', async () => {
    seedRow()
    const deps = makeDeps({
      paneGuard: vi.fn(async () => 'fail' as const),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    // Same-value overwrite with a fresh expiry that bypassed the cancel
    // hook: the next iteration's row check still retires the generation.
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-06-01T00:00:00.000Z',
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('holder drift during guard-failed polling cancels before pasting', async () => {
    seedRow()
    let guardCalls = 0
    const deps = makeDeps({
      paneGuard: vi.fn(async () => {
        guardCalls += 1
        return guardCalls === 1 ? 'fail' as const : 'pass' as const
      }),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    deps.findByIdentityKey = () => [{ ...HOLDER, name: 'someone-else' }]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('holder_changed')
    )
  })

  it('same-value overwrite during guard-failed polling starts a new generation', async () => {
    seedRow()
    const deps = makeDeps({
      paneGuard: vi.fn(async () => 'fail' as const),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    const gen1Id = __peekCodexRecoveryGenerations().get('%1972')
    expect(gen1Id).toBeDefined()

    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-06-01T00:00:00.000Z',
    })
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        expires_at: '2999-06-01T00:00:00.000Z',
      },
      deps
    )
    // Old generation cancelled, a fresh schedule created from the new row.
    const gen2Id = __peekCodexRecoveryGenerations().get('%1972')
    expect(gen2Id).toBeDefined()
    expect(gen2Id).not.toBe(gen1Id)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })

  it('cancellation during guard-failed polling stops it', async () => {
    seedRow()
    let guardCalls = 0
    const pasted: string[] = []
    const deps = makeDeps({
      paneGuard: vi.fn(async () => {
        guardCalls += 1
        return guardCalls === 1 ? 'fail' as const : 'pass' as const
      }),
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    // Consumption/overwrite cancellation lands while the resumed polling
    // waits for its next probe tick.
    cancelCodexRecoverySchedule('%1972')
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pasted).toEqual([])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })

  it('a cancellation during a failing guard is not resurrected', async () => {
    seedRow()
    const deps = makeDeps({
      paneGuard: vi.fn(async () => {
        // Consumption/overwrite lands while the send sits in the quiet
        // guard; the failing guard must not resume the retired generation.
        cancelCodexRecoverySchedule('%1972')
        return 'fail' as const
      }),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })

  it('repeated guard failures keep polling until row expiry, then terminate', async () => {
    let t = new Date('2026-01-01T00:00:00.000Z').getTime()
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2026-01-01T00:00:30.000Z',
    })
    const pasted: string[] = []
    const deps = makeDeps({
      now: () => new Date(t),
      paneGuard: vi.fn(async () => 'fail' as const),
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        expires_at: '2026-01-01T00:00:30.000Z',
      },
      deps
    )
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i += 1) {
      t += 1_000
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    expect(deps.paneGuard).toHaveBeenCalledTimes(6)
    expect(__peekRetryMap().size).toBe(0)
    // Row expiry terminates the guard-failed polling.
    t += 60_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pasted).toEqual([])
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('a consumed row terminates polling before any send', async () => {
    seedRow()
    const deps = makeDeps({
      ttyProcesses: async () => [SHELL_LINE],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    repo.takeByPaneId('%1972')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual([])
  })

  it('row expiry terminates polling', async () => {
    let t = new Date('2026-01-01T00:00:00.000Z').getTime()
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2026-01-01T00:00:30.000Z',
    })
    const deps = makeDeps({
      now: () => new Date(t),
      ttyProcesses: async () => [SHELL_LINE],
    })
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        expires_at: '2026-01-01T00:00:30.000Z',
      },
      deps
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    t += 60_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual([])
  })

  it('same-pane overwrite cancels the old schedule and re-evaluates', async () => {
    seedRow()
    const deps = makeDeps({ ttyProcesses: async () => [SHELL_LINE] })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])

    // Overwrite without a key: old schedule cancelled, nothing new scheduled.
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U2',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    evaluate(deps, null)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()

    // Overwrite with a key again: a fresh schedule is created from the new row.
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    evaluate(deps, 'K1')
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
  })

  it('composite confirm blocks the paste when codex dies after the re-probe', async () => {
    seedRow()
    let codexAlive = true
    const pasted: string[] = []
    const deps = makeDeps({
      // The carrier proof sees codex leave the tty once codexAlive flips.
      foregroundProbeSync: () => codexAlive ? [FG_CODEX_LINE] : [FG_SHELL_LINE],
      tmuxPoke: vi.fn(async (args: {
        pane_id: string
        content: string
        confirmOwnership?: () => boolean
      }) => {
        // Mirror the primitive's pre-paste checkpoint: codex exits right
        // after the post-guard re-probe, before anything is written.
        codexAlive = false
        if (args.confirmOwnership && !args.confirmOwnership()) {
          return { error: 'pane_reassigned' }
        }
        pasted.push(args.content)
        return { ok: true as const, pane_tail_before: '', pane_tail_after: '' }
      }),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(pasted).toEqual([])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('pane_reassigned')
    )
  })

  // A tmuxPoke stub that honors the composite confirm exactly like the real
  // primitive's pre-capture checkpoint: refusal aborts with nothing written.
  function confirmHonoringPoke(pasted: string[]) {
    return vi.fn(async (args: {
      pane_id: string
      content: string
      confirmOwnership?: () => boolean
    }) => {
      if (args.confirmOwnership && !args.confirmOwnership()) {
        return { error: 'pane_reassigned' }
      }
      pasted.push(args.content)
      return { ok: true as const, pane_tail_before: '', pane_tail_after: '' }
    })
  }

  it('a backgrounded codex at send time returns the schedule to polling', async () => {
    seedRow()
    const pasted: string[] = []
    const deps = makeDeps({
      foregroundProbeSync: () => [BG_CODEX_LINE, FG_SHELL_LINE],
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(pasted).toEqual([])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('carrier_backgrounded')
    )
    // The generation survives: the pane is back in the polling loop with the
    // same generation token.
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    expect(__peekCodexRecoveryGenerations().has('%1972')).toBe(true)
  })

  it('foregrounding within the TTL delivers on a later iteration', async () => {
    seedRow()
    let foreground = false
    const pasted: string[] = []
    const deps = makeDeps({
      foregroundProbeSync: () =>
        foreground ? [FG_CODEX_LINE] : [BG_CODEX_LINE, FG_SHELL_LINE],
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(pasted).toHaveLength(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    foreground = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pasted).toHaveLength(1)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('expiry while still backgrounded retires the schedule', async () => {
    let t = new Date('2026-01-01T00:00:00.000Z').getTime()
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2026-01-01T00:00:30.000Z',
    })
    const pasted: string[] = []
    const deps = makeDeps({
      now: () => new Date(t),
      foregroundProbeSync: () => [BG_CODEX_LINE, FG_SHELL_LINE],
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        expires_at: '2026-01-01T00:00:30.000Z',
      },
      deps
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    t += 60_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pasted).toEqual([])
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('a cancellation during a backgrounded refusal is not resurrected', async () => {
    seedRow()
    const deps = makeDeps({
      foregroundProbeSync: () => [BG_CODEX_LINE, FG_SHELL_LINE],
      tmuxPoke: vi.fn(async (args: {
        pane_id: string
        content: string
        confirmOwnership?: () => boolean
      }) => {
        if (args.confirmOwnership && !args.confirmOwnership()) {
          // Consumption/overwrite lands while the refusal unwinds: the
          // resume must observe the retired generation and re-register
          // nothing.
          cancelCodexRecoverySchedule('%1972')
          return { error: 'pane_reassigned' }
        }
        return { ok: true as const, pane_tail_before: '', pane_tail_after: '' }
      }),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
  })

  it('a backgrounded refusal on a superseded generation resumes nothing', async () => {
    seedRow()
    let ttyLines = [CODEX_LINE]
    let interfered = false
    const deps: CodexRecoveryDeps = makeDeps({
      ttyProcesses: async () => ttyLines,
      foregroundProbeSync: () => [BG_CODEX_LINE, FG_SHELL_LINE],
      tmuxPoke: vi.fn(async (args: {
        pane_id: string
        content: string
        confirmOwnership?: () => boolean
      }) => {
        if (args.confirmOwnership && !args.confirmOwnership()) {
          if (!interfered) {
            interfered = true
            // An overwriting pre-register lands while the refusal unwinds:
            // generation 2 replaces generation 1 before the send observes
            // the carrier_backgrounded outcome.
            repo.upsert({
              pane_id: '%1972',
              xats_agent_id: 'U1',
              identity_key: 'K1',
              expires_at: '2999-06-01T00:00:00.000Z',
            })
            evaluateCodexRecoveryOnPreRegister(
              {
                pane_id: '%1972',
                xats_agent_id: 'U1',
                identity_key: 'K1',
                expires_at: '2999-06-01T00:00:00.000Z',
              },
              deps
            )
            // Generation 2 keeps polling without detecting codex.
            ttyLines = [SHELL_LINE]
          }
          return { error: 'pane_reassigned' }
        }
        return { ok: true as const, pane_tail_before: '', pane_tail_after: '' }
      }),
    })
    evaluate(deps)
    const gen1Id = __peekCodexRecoveryGenerations().get('%1972')
    expect(gen1Id).toBeDefined()
    await vi.advanceTimersByTimeAsync(0)
    // Generation 1 resumed nothing: the only live schedule is generation
    // 2's, whose token replaced generation 1's in the pane registration.
    const gen2Id = __peekCodexRecoveryGenerations().get('%1972')
    expect(gen2Id).toBeDefined()
    expect(gen2Id).not.toBe(gen1Id)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
    // Later ticks stay silent: generation 2 keeps polling untouched and
    // generation 1 never pastes.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    expect(__peekCodexRecoveryGenerations().get('%1972')).toBe(gen2Id)
  })

  it('a SIGSTOP-ed codex with a foreground shell never receives a send', async () => {
    seedRow()
    const deps = makeDeps({
      // Reviewer repro: kill(pid, 0) would stay true for the stopped codex
      // while the shell owns the tty. Neither detection nor the carrier
      // proof may treat it as a live codex.
      ttyProcesses: async () => [STOPPED_CODEX_LINE, SHELL_FG_TTY_LINE],
      foregroundProbeSync: () => [
        '91131 91131 555 T codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
        FG_SHELL_LINE,
      ],
      isProcessAlive: pid => pid === 91131,
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.paneGuard).not.toHaveBeenCalled()
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
  })

  it('a wrapper+child pair collapses to the leader pid and the poke proceeds', async () => {
    for (const procs of [
      [WRAPPER_CODEX_LINE, NATIVE_CHILD_CODEX_LINE],
      [NATIVE_CHILD_CODEX_LINE, WRAPPER_CODEX_LINE],
    ]) {
      clearAllCodexRecoverySchedules()
      clearAllRetries()
      seedRow()
      const deps = makeDeps({
        ttyProcesses: async () => procs,
        foregroundProbeSync: () =>
          [WRAPPER_CODEX_LINE, NATIVE_CHILD_CODEX_LINE],
      })
      evaluate(deps)
      await vi.advanceTimersByTimeAsync(0)
      // Detection collapsed to the group leader (the node wrapper).
      expect(deps.verifyPaneHost).toHaveBeenCalledWith(expect.objectContaining({
        paneId: '%1972',
        pid: 39074,
      }))
      expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
      const call = (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        pane_id: string
        content: string
      }
      expect(call.pane_id).toBe('%1972')
      expect(call.content).toContain('aoe-codex')
      expect(call.content).not.toContain('K1')
      expect(__peekCodexRecoverySchedules()).toEqual([])
    }
  })

  it('the carrier proof accepts the wrapper-form leader line', async () => {
    seedRow()
    const pasted: string[] = []
    const deps = makeDeps({
      ttyProcesses: async () => [WRAPPER_CODEX_LINE, NATIVE_CHILD_CODEX_LINE],
      // The composite confirm classifies pid 39074 on this snapshot: the
      // wrapper line (node .../bin/codex --remote) must read as foreground.
      foregroundProbeSync: () => [WRAPPER_CODEX_LINE, NATIVE_CHILD_CODEX_LINE],
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(pasted).toHaveLength(1)
    expect(pasted[0]).toContain('aoe-codex')
  })

  it('matches spanning different process groups detect nothing, logged once', async () => {
    seedRow()
    const deps = makeDeps({
      ttyProcesses: async () => [
        '111 111 111 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
        '222 222 222 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
      ],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.paneGuard).not.toHaveBeenCalled()
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
    const skipLines = logged.filter(l => l.includes('detect skip'))
    expect(skipLines).toHaveLength(1)
    expect(skipLines[0]).toContain('pane=%1972')
    expect(skipLines[0]).toContain('reason=multi_pgid')
    expect(skipLines[0]).toContain('matches=2')
    expect(skipLines[0]).toContain('distinct_pgids=2')
    expect(logged.join('\n')).not.toContain('--remote')
    expect(logged.join('\n')).not.toContain('K1')
  })

  it('a same-group set without a leader line is never a detection', async () => {
    seedRow()
    const deps = makeDeps({
      // Two children share pgid 39074 but no line has pid === pgid.
      ttyProcesses: async () => [
        NATIVE_CHILD_CODEX_LINE,
        '41847 39074 39074 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
      ],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
    const skipLines = logged.filter(l => l.includes('detect skip'))
    expect(skipLines).toHaveLength(1)
    expect(skipLines[0]).toContain('reason=no_foreground_leader')
    expect(skipLines[0]).toContain('distinct_pgids=1')
  })

  it('a zombie codex line is never a detection', async () => {
    seedRow()
    const deps = makeDeps({
      ttyProcesses: async () => [ZOMBIE_CODEX_LINE, SHELL_FG_TTY_LINE],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
  })

  it('a delivered first send releases the generation registration', async () => {
    seedRow()
    const deps = makeDeps()
    evaluate(deps)
    expect(__peekCodexRecoveryGenerations().has('%1972')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('a terminal first-send failure releases the generation registration', async () => {
    seedRow()
    const deps = makeDeps({
      tmuxPoke: vi.fn(async () => ({ error: 'pane_dead' })),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('pane_dead'))
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('a stale suspended send cannot cancel or write over the new generation', async () => {
    seedRow()
    let resolveOldGuard: ((v: 'pass' | 'fail') => void) | undefined
    let guardCalls = 0
    const paneGuard = vi.fn(async () => {
      guardCalls += 1
      if (guardCalls === 1) {
        // Generation-1 first send: suspend until the test resumes it.
        return await new Promise<'pass' | 'fail'>(resolve => {
          resolveOldGuard = resolve
        })
      }
      return 'fail' as const
    })
    const deps = makeDeps({ paneGuard })
    evaluate(deps)
    const gen1Id = __peekCodexRecoveryGenerations().get('%1972')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveOldGuard).toBeDefined()

    // Overwrite lands while the old send is suspended: a new generation
    // whose own first send guard-fails back into the polling loop.
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-06-01T00:00:00.000Z',
    })
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        expires_at: '2999-06-01T00:00:00.000Z',
      },
      deps
    )
    await vi.advanceTimersByTimeAsync(0)
    const gen2Id = __peekCodexRecoveryGenerations().get('%1972')
    expect(gen2Id).toBeDefined()
    expect(gen2Id).not.toBe(gen1Id)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])

    // The old send resumes with a passing guard: superseded, it must
    // neither paste nor disturb the new generation's polling schedule.
    resolveOldGuard?.('pass')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    expect(__peekCodexRecoveryGenerations().get('%1972')).toBe(gen2Id)
  })

  it('probe stage exceptions log once per stage, redacted', async () => {
    seedRow()
    const deps = makeDeps({
      ttyProcesses: async () => { throw new Error('ps blew up for K1') },
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
    const probeLines = logged.filter(l => l.includes('stage=tty_processes'))
    expect(probeLines).toHaveLength(1)
    expect(probeLines[0]).toContain('pane=%1972')
    expect(probeLines[0]).toContain('Error')
    expect(probeLines[0]).toContain('[redacted]')
    expect(logged.join('\n')).not.toContain('K1')
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })

  it('an unexpected probe error logs the class with a redacted message', async () => {
    seedRow()
    let lookups = 0
    const deps = makeDeps({
      findByIdentityKey: () => {
        lookups += 1
        if (lookups === 1) return [HOLDER]
        throw new Error('lookup failed for K1')
      },
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
    const errorLines = logged.filter(l => l.includes('probe error'))
    expect(errorLines).toHaveLength(1)
    expect(errorLines[0]).toContain('pane=%1972')
    expect(errorLines[0]).toContain('stage=iteration')
    expect(errorLines[0]).toContain('Error')
    expect(errorLines[0]).toContain('[redacted]')
    expect(logged.join('\n')).not.toContain('K1')
    expect(__peekCodexRecoverySchedules()).toEqual([])
  })

  it('clearAll cancels pending probes and guard-failed resumed polling', async () => {
    seedRow()
    const deps = makeDeps({
      paneGuard: vi.fn(async () => 'fail' as const),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    clearAllCodexRecoverySchedules()
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })

  it('clearAll during an in-flight send aborts at the next checkpoint', async () => {
    seedRow()
    let resolveGuard: ((v: 'pass' | 'fail') => void) | undefined
    const deps = makeDeps({
      paneGuard: vi.fn(
        () => new Promise<'pass' | 'fail'>(resolve => { resolveGuard = resolve })
      ),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveGuard).toBeDefined()
    // Shutdown lands while the send sits in the quiet guard.
    clearAllCodexRecoverySchedules()
    resolveGuard?.('pass')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexRecoveryGenerations().size).toBe(0)
  })

  it('recovery log lines carry ISO timestamps through the lifecycle', async () => {
    seedRow()
    let guardCalls = 0
    const pasted: string[] = []
    const deps = makeDeps({
      paneGuard: vi.fn(async () => {
        guardCalls += 1
        return guardCalls === 1 ? 'fail' as const : 'pass' as const
      }),
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
    const scheduled = logged.filter(l => l.includes('codex-recovery scheduled'))
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]).toContain('pane=%1972')
    expect(scheduled[0]).toContain('identity=(aoe, aoe-codex)')
    // Detection logs once per distinct pid, not once per iteration.
    const detected = logged.filter(l => l.includes('codex-recovery detected'))
    expect(detected).toHaveLength(1)
    expect(detected[0]).toContain('pid=91131')
    const resumes = logged.filter(l => l.includes('reason=guard_failed'))
    expect(resumes).toHaveLength(1)
    expect(resumes[0]).toContain('resume_probe_polling')
    const delivered = logged.filter(l => l.includes('codex-recovery delivered'))
    expect(delivered).toHaveLength(1)
    for (const line of logged) {
      expect(line).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] codex-recovery /
      )
    }
    expect(logged.join('\n')).not.toContain('K1')
  })

  it('an A→B→A pid flip-flop logs each distinct pid once per generation', async () => {
    seedRow()
    const lineFor = (pid: number): string =>
      `${pid} ${pid} ${pid} Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"`
    // The codex process restarts B, then A's pid comes back (pid reuse or a
    // second restart): A must not be logged twice within one generation.
    const sequence = [[lineFor(91131)], [lineFor(92000)], [lineFor(91131)]]
    let call = 0
    const deps = makeDeps({
      ttyProcesses: async () =>
        sequence[Math.min(call++, sequence.length - 1)],
      paneGuard: vi.fn(async () => 'fail' as const),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
    const detected = logged.filter(l => l.includes('codex-recovery detected'))
    expect(detected).toHaveLength(2)
    expect(detected[0]).toContain('pid=91131')
    expect(detected[1]).toContain('pid=92000')
  })

  it('an active cancellation logs its terminal reason exactly once', async () => {
    seedRow()
    const deps = makeDeps({ ttyProcesses: async () => [SHELL_LINE] })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    const log = vi.fn()
    cancelCodexRecoverySchedule('%1972', {
      reason: 'row_consumed',
      log,
      now: () => new Date('2026-01-01T00:00:20.000Z'),
    })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      '[2026-01-01T00:00:20.000Z] codex-recovery cancelled: '
      + 'pane=%1972 reason=row_consumed'
    )
    // The cancelled closure stays silent afterwards: no duplicate line.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('cancelling a pane with no live schedule logs nothing', () => {
    const log = vi.fn()
    cancelCodexRecoverySchedule('%none', { reason: 'row_consumed', log })
    expect(log).not.toHaveBeenCalled()
  })

  it('an overwrite evaluation logs row_replaced for the retired generation', async () => {
    seedRow()
    const deps = makeDeps({ ttyProcesses: async () => [SHELL_LINE] })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    // First evaluation had no previous schedule: nothing to cancel, no line.
    const before = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
      .filter(l => l.includes('codex-recovery cancelled'))
    expect(before).toEqual([])
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U2',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    evaluate(deps, null)
    const lines = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
      .filter(l => l.includes('codex-recovery cancelled'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('pane=%1972')
    expect(lines[0]).toContain('reason=row_replaced')
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] codex-recovery /
    )
    expect(lines.join('\n')).not.toContain('K1')
  })

  it('clearAll with a shutdown reason logs each cancelled pane', async () => {
    seedRow()
    const deps = makeDeps({ ttyProcesses: async () => [SHELL_LINE] })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    const log = vi.fn()
    clearAllCodexRecoverySchedules({ reason: 'daemon_shutdown', log })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('pane=%1972')
    expect(log.mock.calls[0][0]).toContain('reason=daemon_shutdown')
  })

  it('a guard-failed streak logs once; a new streak logs again', async () => {
    seedRow()
    // Guard: fail, fail (same streak), pass (carrier refuses), fail again.
    const guardResults: Array<'pass' | 'fail'> = ['fail', 'fail', 'pass', 'fail']
    let call = 0
    const pasted: string[] = []
    const deps = makeDeps({
      paneGuard: vi.fn(async () =>
        guardResults[Math.min(call++, guardResults.length - 1)]
      ),
      foregroundProbeSync: () => [BG_CODEX_LINE, FG_SHELL_LINE],
      tmuxPoke: confirmHonoringPoke(pasted),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
    // Two guard-failed streaks (separated by the passing guard) log twice,
    // not once per iteration; the carrier streak logs once.
    expect(logged.filter(l => l.includes('reason=guard_failed')))
      .toHaveLength(2)
    expect(logged.filter(l => l.includes('reason=carrier_backgrounded')))
      .toHaveLength(1)
    expect(pasted).toEqual([])
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
  })

  it('an overwritten row (different uuid) stops the old schedule', async () => {
    seedRow()
    const deps = makeDeps({ ttyProcesses: async () => [SHELL_LINE] })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    // Simulate an overwrite that bypassed the cancel hook: the per-iteration
    // row check still terminates the schedule.
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'OTHER',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(__peekCodexRecoverySchedules()).toEqual([])
  })
})
