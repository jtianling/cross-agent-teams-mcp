import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import {
  __peekCodexRecoverySchedules,
  clearAllCodexRecoverySchedules,
  evaluateCodexRecoveryOnPreRegister,
  type CodexRecoveryDeps,
} from '../src/mcp/codex-recovery-poke.js'
import type { IdentityKeyMatch } from '../src/storage/agents-repo.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-recovery-declared-'))
const CODEX_LINE =
  '91131 91131 91131 Ss codex --remote ws://127.0.0.1:8799 ' +
  '-c xats.agent_id="U1"'
const SHELL_LINE = '555 555 555 Ss -zsh'
const FG_CODEX_LINE =
  '91131 91131 91131 S+ codex --remote ws://127.0.0.1:8799 ' +
  '-c xats.agent_id="U1"'
// The refusal must name its release condition AND the fact that some runtimes
// never satisfy it; a string promising recovery "later" would read as
// wait-and-see for an identity that in fact needs a human.
const UNKNOWN_CONSEQUENCE =
  'consequence=blocked_until_this_identity_registers_with_a_positive_pid '
  + 'note=runtimes_that_never_record_one(kimi-code,opencode,tty-bound_codex)'
  + '_do_not_clear_this_without_operator_action'

const KEY_HOLDER: IdentityKeyMatch = {
  agent_id: 'key-holder',
  device: 'local',
  team: 'aoe',
  name: 'aoe-codex',
  role: 'default',
  runtime_ui_pid: 4242,
  last_seen_at: '2026-01-01T00:00:00.000Z',
}

const DECLARED_HOLDER: IdentityKeyMatch = {
  agent_id: 'declared-holder',
  device: 'local',
  team: 'monkeys',
  name: 'mvr-coder',
  role: 'default',
  runtime_ui_pid: 4343,
  last_seen_at: '2026-01-01T00:00:00.000Z',
}

describe('codex recovery declared identity', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    vi.useFakeTimers()
    clearAllCodexRecoverySchedules()
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    clearAllCodexRecoverySchedules()
    vi.useRealTimers()
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(dir => rmSync(dir, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function makeDeps(
    overrides: Partial<CodexRecoveryDeps> = {}
  ): CodexRecoveryDeps {
    return {
      repo,
      findByIdentityKey: () => [],
      findByDeclaredIdentity: () => DECLARED_HOLDER,
      localDevice: 'local',
      isProcessAlive: () => false,
      listPanes: async () => [{ pane_id: '%25', tty: 'ttys001' }],
      ttyProcesses: async () => [SHELL_LINE],
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

  function evaluate(
    deps: CodexRecoveryDeps,
    overrides: {
      identity_key?: string | null
      team?: string | null
      agent_name?: string | null
    } = {}
  ): void {
    const row = {
      pane_id: '%25',
      xats_agent_id: 'U1',
      identity_key: overrides.identity_key ?? null,
      team: overrides.team === undefined ? 'monkeys' : overrides.team,
      agent_name:
        overrides.agent_name === undefined ? 'mvr-coder' : overrides.agent_name,
      expires_at: '2999-01-01T00:00:00.000Z',
    }
    repo.upsert({
      ...row,
      identity_key: row.identity_key ?? undefined,
    })
    evaluateCodexRecoveryOnPreRegister(row, deps)
  }

  it.each([null, 'unknown-key'])(
    'schedules from a complete declaration on key miss %s',
    identityKey => {
      const deps = makeDeps()
      evaluate(deps, { identity_key: identityKey })
      expect(__peekCodexRecoverySchedules()).toEqual(['%25'])
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining('source=declaration')
      )
    }
  )

  it('a declaration naming no row still schedules and sends', async () => {
    const deps = makeDeps({
      findByDeclaredIdentity: () => undefined,
      ttyProcesses: async () => [CODEX_LINE],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).toHaveBeenCalledTimes(1)
    const call = (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.content).toContain('name="mvr-coder"')
    expect(call.content).toContain('team="monkeys"')
    expect(deps.verifyPaneHost).toHaveBeenCalledWith(expect.objectContaining({
      holderAgentId: null,
    }))
  })

  it('a live declared holder blocks scheduling and is named in the log', () => {
    const deps = makeDeps({ isProcessAlive: pid => pid === 4343 })
    evaluate(deps)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    const logs = (deps.log as ReturnType<typeof vi.fn>).mock.calls.join('\n')
    expect(logs).toContain('pane=%25')
    expect(logs).toContain('declared_identity=(monkeys, mvr-coder)')
    expect(logs).toContain('current_holder=declared-holder')
  })

  it('a pid-less declared holder blocks scheduling as liveness unknown', () => {
    const deps = makeDeps({
      findByDeclaredIdentity: () => ({
        ...DECLARED_HOLDER,
        runtime_ui_pid: null,
      }),
    })
    evaluate(deps)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining(
        `reason=holder_liveness_unknown ${UNKNOWN_CONSEQUENCE}`
      )
    )
  })

  it.each([
    { team: 'monkeys', agent_name: null },
    { team: null, agent_name: 'mvr-coder' },
  ])('a partial declaration schedules nothing and logs debug', declaration => {
    const deps = makeDeps()
    evaluate(deps, declaration)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('reason=incomplete_declaration')
    )
  })

  it('a key hit wins over a conflicting declaration without key logs', async () => {
    const deps = makeDeps({
      findByIdentityKey: () => [KEY_HOLDER],
      ttyProcesses: async () => [CODEX_LINE],
    })
    evaluate(deps, { identity_key: 'SECRET_KEY' })
    await vi.advanceTimersByTimeAsync(0)
    const call = (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.content).toContain('name="aoe-codex"')
    expect(call.content).toContain('team="aoe"')
    expect(call.content).not.toContain('SECRET_KEY')
    const logs = (deps.log as ReturnType<typeof vi.fn>).mock.calls.join('\n')
    expect(logs).toContain('key_identity=(aoe, aoe-codex)')
    expect(logs).toContain('declared_identity=(monkeys, mvr-coder)')
    expect(logs).toContain('source=key')
    expect(logs).not.toContain('SECRET_KEY')
  })

  it('a live key holder skips without falling back to declaration', () => {
    const findByDeclaredIdentity = vi.fn(() => DECLARED_HOLDER)
    const deps = makeDeps({
      findByIdentityKey: () => [KEY_HOLDER],
      findByDeclaredIdentity,
      isProcessAlive: pid => pid === KEY_HOLDER.runtime_ui_pid,
    })
    evaluate(deps, { identity_key: 'K1' })
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(findByDeclaredIdentity).not.toHaveBeenCalled()
  })

  it('a declared holder becoming alive cancels at the next poll', async () => {
    let alive = false
    let lookups = 0
    const deps = makeDeps({
      findByDeclaredIdentity: () => {
        lookups += 1
        return DECLARED_HOLDER
      },
      isProcessAlive: () => alive,
    })
    evaluate(deps)
    alive = true
    await vi.advanceTimersByTimeAsync(0)
    expect(lookups).toBeGreaterThanOrEqual(2)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('reason=holder_alive')
    )
  })

  it('an absent declaration is re-read and keeps polling', async () => {
    let lookups = 0
    const deps = makeDeps({
      findByDeclaredIdentity: () => {
        lookups += 1
        return undefined
      },
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lookups).toBeGreaterThanOrEqual(3)
    expect(__peekCodexRecoverySchedules()).toEqual(['%25'])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })

  it('a pid-less declared holder appearing during polling cancels', async () => {
    let lookups = 0
    const deps = makeDeps({
      findByDeclaredIdentity: () => {
        lookups += 1
        if (lookups === 1) return undefined
        return { ...DECLARED_HOLDER, runtime_ui_pid: null }
      },
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining(
        `reason=holder_liveness_unknown ${UNKNOWN_CONSEQUENCE}`
      )
    )
  })

  it('a pid-less holder before send logs the same consequence', async () => {
    let pidless = false
    const deps = makeDeps({
      findByDeclaredIdentity: () => ({
        ...DECLARED_HOLDER,
        runtime_ui_pid: pidless ? null : DECLARED_HOLDER.runtime_ui_pid,
      }),
      ttyProcesses: async () => [CODEX_LINE],
      paneGuard: vi.fn(async () => {
        pidless = true
        return 'pass' as const
      }),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining(
        `reason=holder_liveness_unknown ${UNKNOWN_CONSEQUENCE}`
      )
    )
  })

  it('a declared holder reviving during the guard blocks the send', async () => {
    let alive = false
    const deps = makeDeps({
      isProcessAlive: () => alive,
      ttyProcesses: async () => [CODEX_LINE],
      paneGuard: vi.fn(async () => {
        alive = true
        return 'pass' as const
      }),
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('reason=holder_alive')
    )
  })

  it('key and declaration sources use the same notice template', async () => {
    const keyPokes: string[] = []
    const keyDeps = makeDeps({
      findByIdentityKey: () => [DECLARED_HOLDER],
      ttyProcesses: async () => [CODEX_LINE],
      tmuxPoke: vi.fn(async args => {
        keyPokes.push(args.content)
        return { error: 'pane_dead' as const }
      }),
    })
    evaluate(keyDeps, { identity_key: 'SECRET_KEY' })
    await vi.advanceTimersByTimeAsync(0)

    const declaredPokes: string[] = []
    const declaredDeps = makeDeps({
      findByDeclaredIdentity: () => DECLARED_HOLDER,
      ttyProcesses: async () => [CODEX_LINE],
      tmuxPoke: vi.fn(async args => {
        declaredPokes.push(args.content)
        return { error: 'pane_dead' as const }
      }),
    })
    evaluate(declaredDeps)
    await vi.advanceTimersByTimeAsync(0)

    const normalizeNonce = (content: string): string => content.replace(
      /recovery_nonce: "[^"]+"/,
      'recovery_nonce: "TOKEN"'
    )
    expect(normalizeNonce(keyPokes[0])).toBe(normalizeNonce(declaredPokes[0]))
    expect(keyPokes[0]).not.toContain('SECRET_KEY')
    expect((keyDeps.log as ReturnType<typeof vi.fn>).mock.calls.join('\n'))
      .toContain('source=key')
    expect((declaredDeps.log as ReturnType<typeof vi.fn>).mock.calls.join('\n'))
      .toContain('source=declaration')
  })

  it('the notice does not reveal whether the source was a declaration', async () => {
    const deps = makeDeps({
      findByDeclaredIdentity: () => undefined,
      ttyProcesses: async () => [CODEX_LINE],
    })
    evaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    const call = (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.content).not.toContain('declaration')
    expect(call.content).not.toContain('identity_key')
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('source=declaration')
    )
  })
})
