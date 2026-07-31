import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
  return {
    ...actual,
    isTmuxAvailable: vi.fn(async () => true),
    capturePaneTail: vi.fn(async () => 'tail'),
    loadBuffer: vi.fn(async () => {}),
    pasteBuffer: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    deleteBuffer: vi.fn(async () => {}),
  }
})

import * as tmuxCli from '../src/daemon/tmux-cli.js'
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

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-recovery-confirm-'))

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
// Foreground-probe format: pid pgid tpgid stat command.
const FG_CODEX_LINE =
  '91131 91131 91131 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const FG_SHELL_LINE = '555 555 555 S+ -zsh'
const FG_STOPPED_CODEX_LINE =
  '91131 91131 555 T codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const FG_ZOMBIE_CODEX_LINE =
  '91131 91131 91131 Z codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const FG_PID_REUSE_LINE = '91131 91131 91131 S+ vim notes.txt'
// Real aoe launch shape: node wrapper leads the foreground process group and
// the native child shares the pgid; both match codex --remote + uuid.
const WRAPPER_CODEX_LINE =
  '39074 39074 39074 Ss+ node /Users/jtianling/.nvm/versions/node/v22.11.0/'
  + 'bin/codex --remote ws://127.0.0.1:8799 -C /Users/jtianling/workspace/aoe'
  + ' -c xats.agent_id="U1"'
const NATIVE_CHILD_CODEX_LINE =
  '41846 39074 39074 S+ /Users/jtianling/.local/share/codex-darwin-arm64/'
  + 'vendor/aarch64-apple-darwin/bin/codex --remote ws://127.0.0.1:8799'
  + ' -C /Users/jtianling/workspace/aoe -c xats.agent_id="U1"'

// These tests run the REAL tmuxPokeImpl (tmux-cli mocked above) so the
// composite confirm predicate is exercised at the primitive's own pre-paste
// and pre-Enter checkpoints, exactly where the reviewer's race lives.
describe('codex recovery composite confirm through the real poke primitive', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo
  let codexAlive: boolean

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearAllCodexRecoverySchedules()
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
    codexAlive = true
  })

  afterEach(() => {
    clearAllCodexRecoverySchedules()
    vi.useRealTimers()
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function makeDeps(overrides: Partial<CodexRecoveryDeps> = {}): CodexRecoveryDeps {
    return {
      repo,
      findByIdentityKey: () => [HOLDER],
      localDevice: 'local',
      // Holder pid (4242) stays dead; the confirm's target-side evidence now
      // comes from the foreground carrier probe, which tracks codexAlive.
      isProcessAlive: () => false,
      listPanes: async () => [{ pane_id: '%1972', tty: 'ttys001' }],
      ttyProcesses: async () => [CODEX_LINE],
      foregroundProbeSync: () =>
        codexAlive ? [FG_CODEX_LINE] : [FG_SHELL_LINE],
      now: () => new Date('2026-01-01T00:00:10.000Z'),
      probeIntervalMs: 1_000,
      verifyPaneHost: vi.fn(async () => ({ ok: true as const })),
      paneGuard: vi.fn(async () => 'pass' as const),
      log: vi.fn(),
      ...overrides,
    }
  }

  function seedAndEvaluate(deps: CodexRecoveryDeps): void {
    repo.upsert({
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        expires_at: '2999-01-01T00:00:00.000Z',
      },
      deps
    )
  }

  it('codex exit after the post-guard re-probe blocks the paste entirely', async () => {
    const deps = makeDeps({
      // Codex dies after the re-probe and pane-host verification, right
      // before the primitive's first synchronous ownership read.
      verifyPaneHost: vi.fn(async () => {
        codexAlive = false
        return { ok: true as const }
      }),
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('pane_reassigned')
    )
  })

  it('codex exit between paste and Enter aborts without executing', async () => {
    const deps = makeDeps()
    vi.mocked(tmuxCli.pasteBuffer).mockImplementationOnce(async () => {
      // The paste lands, then codex dies inside the settle window.
      codexAlive = false
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('ownership_lost')
    )
  })

  it('a live codex pastes and executes normally end to end', async () => {
    const deps = makeDeps()
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('codex-recovery delivered')
    )
    const loaded = vi.mocked(tmuxCli.loadBuffer).mock.calls[0][1]
    expect(loaded).toContain('aoe-codex')
    expect(loaded).not.toContain('K1')
  })

  it('a wrapper+child pair delivers end to end via the leader pid', async () => {
    const deps = makeDeps({
      ttyProcesses: async () => [WRAPPER_CODEX_LINE, NATIVE_CHILD_CODEX_LINE],
      foregroundProbeSync: () =>
        [WRAPPER_CODEX_LINE, NATIVE_CHILD_CODEX_LINE],
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    // Detection and every write-checkpoint proof ran against pid 39074, the
    // group leader whose line is the node wrapper form.
    expect(deps.verifyPaneHost).toHaveBeenCalledWith(expect.objectContaining({
      pid: 39074,
    }))
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('codex-recovery delivered')
    )
  })

  function expectNothingWritten(deps: CodexRecoveryDeps): void {
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('pane_reassigned')
    )
  }

  it('a SIGSTOP-ed codex with a foreground shell blocks every write', async () => {
    // Reviewer repro at the write checkpoint: the pid is alive for
    // kill(pid, 0), but STAT is T and the shell is the tty's foreground.
    const deps = makeDeps({
      foregroundProbeSync: () => [FG_STOPPED_CODEX_LINE, FG_SHELL_LINE],
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expectNothingWritten(deps)
  })

  it('a zombie codex blocks every write', async () => {
    const deps = makeDeps({
      foregroundProbeSync: () => [FG_ZOMBIE_CODEX_LINE],
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expectNothingWritten(deps)
  })

  it('PID reuse (command changed) blocks every write', async () => {
    const deps = makeDeps({
      foregroundProbeSync: () => [FG_PID_REUSE_LINE],
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expectNothingWritten(deps)
  })

  it('a foreground-probe error (EPERM) blocks every write', async () => {
    const deps = makeDeps({
      foregroundProbeSync: () => {
        throw Object.assign(new Error('ps: EPERM'), { code: 'EPERM' })
      },
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expectNothingWritten(deps)
  })

  it('a background codex (pgid != tpgid) blocks every write and keeps polling', async () => {
    const deps = makeDeps({
      foregroundProbeSync: () => [
        '91131 91131 555 S codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"',
        FG_SHELL_LINE,
      ],
    })
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    // W1: the transient refusal returns the schedule to the polling loop
    // instead of retiring the generation.
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('carrier_backgrounded')
    )
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
  })
})
