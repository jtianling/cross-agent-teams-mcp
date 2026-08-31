import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Both codex-side send paths run the REAL tmuxPokeImpl here, so the readiness
// predicate is exercised where it actually sits: inside the primitive, between
// the pre-write capture and the buffer load.  tmux is mocked for every test in
// this file; nothing here may reach a real tmux server.
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
  __peekCodexRecoveryGenerations,
  __peekCodexRecoverySchedules,
  clearAllCodexRecoverySchedules,
  evaluateCodexRecoveryOnPreRegister,
  type CodexRecoveryDeps,
} from '../src/mcp/codex-recovery-poke.js'
import {
  __peekCodexSeedingSchedules,
  clearAllCodexSeedingSchedules,
  evaluateCodexSeedingOnPreRegister,
  type CodexSeedingDeps,
} from '../src/mcp/codex-seeding-poke.js'
import {
  clearAllCodexRecoveryNonces,
  hasDeliveredCodexRecoveryNonce,
} from '../src/mcp/codex-recovery-nonce.js'
import type { IdentityKeyMatch } from '../src/storage/agents-repo.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-readiness-'))

// The blocking startup menu from the observed incident: motionless, so the
// quiet guard passes, and its default action terminates codex.
const MENU_TAIL = [
  'Update available! 0.150.0 -> 0.151.0',
  '  1. Update now (runs npm install -g @openai/codex)',
  'Press enter to continue',
].join('\n')
const COMPOSER_TAIL = '› Ask Codex to do anything'

const EXPIRES = '2999-01-01T00:00:00.000Z'

function setPaneTail(tail: string): void {
  vi.mocked(tmuxCli.capturePaneTail).mockResolvedValue(tail)
}

function logLines(log: unknown): string[] {
  return (log as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]))
}

describe('codex recovery refuses a pane that is not at a composer', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

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
  const FG_CODEX_LINE =
    '91131 91131 91131 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearAllCodexRecoverySchedules()
    clearAllCodexRecoveryNonces()
    setPaneTail(MENU_TAIL)
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    clearAllCodexRecoverySchedules()
    clearAllCodexRecoveryNonces()
    vi.useRealTimers()
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function makeDeps(overrides: Partial<CodexRecoveryDeps> = {}): CodexRecoveryDeps {
    return {
      repo,
      findByIdentityKey: () => [HOLDER],
      findByDeclaredIdentity: () => undefined,
      localDevice: 'local',
      isProcessAlive: () => false,
      listPanes: async () => [{ pane_id: '%1972', tty: 'ttys001' }],
      ttyProcesses: async () => [CODEX_LINE],
      foregroundProbeSync: () => [FG_CODEX_LINE],
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
      expires_at: EXPIRES,
    })
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%1972',
        xats_agent_id: 'U1',
        identity_key: 'K1',
        team: null,
        agent_name: null,
        expires_at: EXPIRES,
      },
      deps
    )
  }

  it('a blocking menu that passes the quiet guard is never written into', async () => {
    const deps = makeDeps()
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.paneGuard).toHaveBeenCalledWith('%1972')
    expect(vi.mocked(tmuxCli.loadBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    // Transient: the generation returns to the polling loop rather than
    // retiring, so a codex that reaches its composer later still recovers.
    expect(__peekCodexRecoverySchedules()).toEqual(['%1972'])
    expect(__peekCodexRecoveryGenerations().has('%1972')).toBe(true)
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('reason=prompt_not_ready action=resume_probe_polling')
    )
    expect(logLines(deps.log).some(l => l.includes('guard_failed'))).toBe(false)
  })

  it('a refusal streak logs once, and a relapse after it passes logs anew', async () => {
    // Iteration 2 answers foreground on the primitive's pre-capture confirm and
    // background on its post-load one, so the readiness predicate really is
    // reached and passes on the composer tail before the carrier refusal aborts
    // the write.  Answering background on the FIRST confirm instead would abort
    // ahead of the predicate and prove nothing about it.
    const BG_CODEX_LINE =
      '91131 91131 555 S codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
    let iteration = 0
    let confirms = 0
    const deps = makeDeps({
      foregroundProbeSync: () => {
        confirms += 1
        return iteration === 2 && confirms > 1 ? [BG_CODEX_LINE] : [FG_CODEX_LINE]
      },
    })
    const readinessLines = (): string[] =>
      logLines(deps.log).filter(l => l.includes('reason=prompt_not_ready'))

    iteration = 1
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(readinessLines()).toHaveLength(1)

    // Same state one interval later: the streak stays at one line.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readinessLines()).toHaveLength(1)

    iteration = 2
    confirms = 0
    setPaneTail(COMPOSER_TAIL)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('reason=carrier_backgrounded')
    )
    // The predicate passed: the buffer was loaded, and only the post-load
    // carrier confirm stopped the write short of the paste.
    expect(vi.mocked(tmuxCli.loadBuffer)).toHaveBeenCalledTimes(1)

    iteration = 3
    confirms = 0
    setPaneTail(MENU_TAIL)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readinessLines()).toHaveLength(2)
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
  })

  it('an idle composer delivers through the unchanged write sequence', async () => {
    setPaneTail(COMPOSER_TAIL)
    const deps = makeDeps()
    seedAndEvaluate(deps)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('codex-recovery delivered')
    )
  })
})

describe('codex seeding refuses a pane that is not at a composer', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  const LEFT = { pane_id: '%10', tty: 'ttys001', uuid: 'U_LEFT', pid: 5010 }
  const RIGHT = { pane_id: '%20', tty: 'ttys002', uuid: 'U_RIGHT', pid: 5020 }
  const PANES = [LEFT, RIGHT]
  type Pane = typeof LEFT

  function fgLine(pane: Pane): string {
    return `${pane.pid} ${pane.pid} ${pane.pid} S+ codex --remote `
      + `ws://127.0.0.1:8799 -c xats.agent_id="${pane.uuid}"`
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearAllCodexSeedingSchedules()
    clearAllCodexRecoverySchedules()
    clearAllCodexRecoveryNonces()
    setPaneTail(MENU_TAIL)
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    clearAllCodexSeedingSchedules()
    clearAllCodexRecoverySchedules()
    clearAllCodexRecoveryNonces()
    vi.useRealTimers()
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function makeDeps(): CodexSeedingDeps {
    return {
      repo,
      listPanes: async () => PANES.map(p => ({ pane_id: p.pane_id, tty: p.tty })),
      ttyProcesses: async (tty: string) => {
        const pane = PANES.find(p => p.tty === tty)
        return pane ? [fgLine(pane)] : []
      },
      foregroundProbeSync: (tty: string) => {
        const pane = PANES.find(p => p.tty === tty)
        return pane ? [fgLine(pane)] : []
      },
      now: () => new Date('2026-01-01T00:00:10.000Z'),
      probeIntervalMs: 1_000,
      log: vi.fn(),
    }
  }

  function seedBoth(): void {
    for (const pane of PANES) {
      repo.upsert({
        pane_id: pane.pane_id,
        xats_agent_id: pane.uuid,
        expires_at: EXPIRES,
      })
    }
  }

  it('a blocking menu writes no token and keeps the round retriable', async () => {
    seedBoth()
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(
      { pane_id: RIGHT.pane_id, xats_agent_id: RIGHT.uuid, identity_key: null,
        expires_at: EXPIRES },
      deps
    )
    await vi.advanceTimersByTimeAsync(2_500)

    expect(vi.mocked(tmuxCli.loadBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    // No token reached either pane, so no nonce may count as delivered and the
    // rows stay pending for a later iteration.
    for (const pane of PANES) {
      expect(hasDeliveredCodexRecoveryNonce(pane.pane_id)).toBe(false)
    }
    expect(repo.listUnexpired('2026-01-01T00:00:10.000Z')).toHaveLength(2)
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('reason=prompt_not_ready action=resume_probe_polling')
    )
    expect(__peekCodexSeedingSchedules().sort()).toEqual(['%10', '%20'])
  })

  it('an idle composer seeds both panes as before', async () => {
    setPaneTail(COMPOSER_TAIL)
    seedBoth()
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(
      { pane_id: RIGHT.pane_id, xats_agent_id: RIGHT.uuid, identity_key: null,
        expires_at: EXPIRES },
      deps
    )
    await vi.advanceTimersByTimeAsync(3_000)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(2)
    expect(__peekCodexSeedingSchedules()).toEqual([])
  })
})
