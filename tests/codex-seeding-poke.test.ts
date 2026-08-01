import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The seeding send path runs the REAL tmuxPokeImpl in the delivery tests, so
// the composite carrier confirm is exercised at the primitive's own write
// checkpoints.  Mocked here for every test in the file: nothing in this suite
// may reach a real tmux server.
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
import { autoBindCodexPane } from '../src/mcp/auto-bind-codex-pane.js'
import {
  __peekCodexSeedingSchedules,
  buildCodexSeedingPokeContent,
  cancelCodexSeedingSchedule,
  clearAllCodexSeedingSchedules,
  evaluateCodexSeedingOnPreRegister,
  type CodexSeedingDeps,
} from '../src/mcp/codex-seeding-poke.js'
import {
  __peekCodexRecoverySchedules,
  clearAllCodexRecoverySchedules,
  evaluateCodexRecoveryOnPreRegister,
  type CodexRecoveryDeps,
} from '../src/mcp/codex-recovery-poke.js'
import {
  clearAllCodexRecoveryNonces,
  consumeCodexRecoveryNonce,
  hasDeliveredCodexRecoveryNonce,
  mintCodexRecoveryNonce,
  resolveCodexRecoveryNonce,
} from '../src/mcp/codex-recovery-nonce.js'
import type { IdentityKeyMatch } from '../src/storage/agents-repo.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-seeding-'))

// Two panes, each hosting its own carrier carrying its OWN row's uuid: the
// shape of two codex panes launched at once, and the shape under which the
// scan's unique-candidate rule refuses every caller.
const LEFT = { pane_id: '%10', tty: 'ttys001', uuid: 'U_LEFT', pid: 5010 }
const RIGHT = { pane_id: '%20', tty: 'ttys002', uuid: 'U_RIGHT', pid: 5020 }
const PANES = [LEFT, RIGHT]

type Pane = typeof LEFT

const EXPIRES = '2999-01-01T00:00:00.000Z'

// ps format: pid pgid tpgid stat command.
function fgLine(pane: Pane): string {
  return `${pane.pid} ${pane.pid} ${pane.pid} S+ codex --remote `
    + `ws://127.0.0.1:8799 -c xats.agent_id="${pane.uuid}"`
}
// Live codex whose process group is not the tty's foreground group.
function bgLine(pane: Pane): string {
  return `${pane.pid} ${pane.pid} 555 S codex --remote `
    + `ws://127.0.0.1:8799 -c xats.agent_id="${pane.uuid}"`
}
const FG_SHELL_LINE = '555 555 555 S+ -zsh'

function nonceIn(content: string): string {
  const m = content.match(/recovery_nonce: "([^"]+)"/)
  if (m === null) throw new Error(`no nonce in notice: ${content}`)
  return m[1]
}

const HOLDER: IdentityKeyMatch = {
  agent_id: 'holder-1',
  device: 'local',
  team: 'aoe',
  name: 'aoe-codex',
  role: 'default',
  runtime_ui_pid: 4242,
  last_seen_at: '2026-01-01T00:00:00.000Z',
}

describe('codex seeding poke', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearAllCodexSeedingSchedules()
    clearAllCodexRecoverySchedules()
    clearAllCodexRecoveryNonces()
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

  function seedRow(pane: Pane, identityKey?: string): void {
    repo.upsert({
      pane_id: pane.pane_id,
      xats_agent_id: pane.uuid,
      identity_key: identityKey,
      expires_at: EXPIRES,
    })
  }

  function writer(pane: Pane, identityKey: string | null = null) {
    return {
      pane_id: pane.pane_id,
      xats_agent_id: pane.uuid,
      identity_key: identityKey,
      expires_at: EXPIRES,
    }
  }

  function makeDeps(overrides: Partial<CodexSeedingDeps> = {}): CodexSeedingDeps {
    return {
      repo,
      listPanes: async () =>
        PANES.map(p => ({ pane_id: p.pane_id, tty: p.tty })),
      ttyProcesses: async (tty: string) => {
        const pane = PANES.find(p => p.tty === tty)
        return pane ? [fgLine(pane)] : []
      },
      // Always injected: the default seam would exec real ps.
      foregroundProbeSync: (tty: string) => {
        const pane = PANES.find(p => p.tty === tty)
        return pane ? [fgLine(pane)] : []
      },
      now: () => new Date('2026-01-01T00:00:10.000Z'),
      probeIntervalMs: 1_000,
      tmuxPoke: vi.fn(async () => ({
        ok: true as const,
        pane_tail_before: '',
        pane_tail_after: '',
      })),
      log: vi.fn(),
      ...overrides,
    }
  }

  function pokeCalls(deps: CodexSeedingDeps): Array<{
    pane_id: string
    content: string
  }> {
    return (deps.tmuxPoke as ReturnType<typeof vi.fn>).mock.calls
      .map(call => call[0] as { pane_id: string; content: string })
  }

  function logLines(deps: CodexSeedingDeps): string[] {
    return (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(call => String(call[0]))
  }

  it('a single pending row is sent nothing, and the decision is logged', () => {
    seedRow(LEFT)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(LEFT), deps)
    expect(__peekCodexSeedingSchedules()).toEqual([])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    // A silent no-op is indistinguishable from a broken trigger.
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('outcome=no_ambiguity')
    )
  })

  it('two pending rows schedule BOTH panes, not only the one that wrote', () => {
    // The earlier pane's codex may already be up and about to register, so
    // scheduling only the writer would leave it with nothing to quote.
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    expect(__peekCodexSeedingSchedules().sort()).toEqual(['%10', '%20'])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('outcome=scheduled seeded=%10,%20')
    )
  })

  it('a row consumed before the next one lands never reaches the trigger', async () => {
    seedRow(LEFT)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(LEFT), deps)
    // LEFT's codex registers and consumes its row before RIGHT is announced.
    repo.takeByPaneId(LEFT.pane_id)
    seedRow(RIGHT)
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)

    expect(__peekCodexSeedingSchedules()).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
    expect(logLines(deps).filter(l => l.includes('outcome=no_ambiguity')))
      .toHaveLength(2)
  })

  it('a pane holding a recovery token keeps it and is not seeded', async () => {
    seedRow(LEFT, 'K1')
    const recoveryDeps: CodexRecoveryDeps = {
      repo,
      findByIdentityKey: () => [HOLDER],
      localDevice: 'local',
      isProcessAlive: () => false,
      listPanes: async () => [{ pane_id: LEFT.pane_id, tty: LEFT.tty }],
      ttyProcesses: async () => [fgLine(LEFT)],
      foregroundProbeSync: () => [fgLine(LEFT)],
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
    }
    evaluateCodexRecoveryOnPreRegister(writer(LEFT, 'K1'), recoveryDeps)
    expect(__peekCodexRecoverySchedules()).toEqual(['%10'])
    await vi.advanceTimersByTimeAsync(0)
    const recoveryNonce = nonceIn(
      (recoveryDeps.tmuxPoke as ReturnType<typeof vi.fn>).mock
        .calls[0][0].content as string
    )

    seedRow(RIGHT)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)

    expect(__peekCodexSeedingSchedules()).toEqual(['%20'])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('seeded=%20 held=%10(token)')
    )
    // The recovery notice sitting in %10 quotes THIS token; minting a seeding
    // one for the same pane would silently invalidate it.
    expect(resolveCodexRecoveryNonce(recoveryNonce)).toBe('%10')
  })

  it('a pane with a live recovery schedule is held before any token exists', () => {
    // Same rule one step earlier: the recovery generation is live but has not
    // reached its send, so there is no nonce to detect it by.
    seedRow(LEFT, 'K1')
    seedRow(RIGHT)
    const recoveryDeps: CodexRecoveryDeps = {
      repo,
      findByIdentityKey: () => [HOLDER],
      localDevice: 'local',
      isProcessAlive: () => false,
      listPanes: async () => [],
      ttyProcesses: async () => [],
      foregroundProbeSync: () => [],
      log: vi.fn(),
    }
    evaluateCodexRecoveryOnPreRegister(writer(LEFT, 'K1'), recoveryDeps)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)

    expect(__peekCodexSeedingSchedules()).toEqual(['%20'])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('seeded=%20 held=%10(recovery)')
    )
  })

  it('a send that wrote nothing does not hold the pane out of later rounds', async () => {
    // The nonce is minted BEFORE the write, so "a nonce exists" and "a notice
    // is in the pane" are different facts.  Treating the first as the second
    // held panes that never received anything out of every subsequent round —
    // reinstating the very candidate-ambiguity deadlock this change removes.
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps({
      tmuxPoke: vi.fn(async () => ({ error: 'tmux_unavailable' as const })),
    })
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    await vi.advanceTimersByTimeAsync(0)

    expect(pokeCalls(deps)).toHaveLength(2)
    expect(__peekCodexSeedingSchedules()).toEqual([])

    const third = { pane_id: '%30', uuid: 'U-30', tty: 'ttys030', pid: 3030 }
    seedRow(third)
    const next = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(third), next)

    expect(__peekCodexSeedingSchedules().sort())
      .toEqual(['%10', '%20', '%30'])
    expect(logLines(next).join('\n')).toContain('held=-')
  })

  it('a post-paste stage failure DOES hold the pane', async () => {
    // paste_buffer already succeeded, so the token is in the pane even though
    // the primitive reports a failure.  Which stages are post-paste is knowable
    // only inside the primitive, which is why the callers ask it rather than
    // matching on the error name.
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps({
      tmuxPoke: vi.fn(async () => ({
        error: 'tmux_cmd_failed' as const,
        detail: { stage: 'send_keys', stderr: 'boom' },
      })),
    })
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    await vi.advanceTimersByTimeAsync(0)

    const third = { pane_id: '%30', uuid: 'U-30', tty: 'ttys030', pid: 3030 }
    seedRow(third)
    const next = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(third), next)

    expect(__peekCodexSeedingSchedules()).toEqual(['%30'])
    expect(logLines(next).join('\n'))
      .toContain('held=%10(token),%20(token)')
  })

  it('a PRE-paste stage failure does not hold the pane', async () => {
    // Same error name, nothing written: the stage is what separates them.
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps({
      tmuxPoke: vi.fn(async () => ({
        error: 'tmux_cmd_failed' as const,
        detail: { stage: 'load_buffer', stderr: 'boom' },
      })),
    })
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    await vi.advanceTimersByTimeAsync(0)

    const third = { pane_id: '%30', uuid: 'U-30', tty: 'ttys030', pid: 3030 }
    seedRow(third)
    const next = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(third), next)

    expect(__peekCodexSeedingSchedules().sort())
      .toEqual(['%10', '%20', '%30'])
    expect(logLines(next).join('\n')).toContain('held=-')
  })

  it('a send outliving its generation cannot mark the replacement token', async () => {
    // The send is asynchronous.  One that started under an earlier generation
    // can return after the row was overwritten and a new token minted; marking
    // by PANE would flag that replacement — which nothing has written — as
    // delivered, and strand the pane out of every later round.
    seedRow(LEFT)
    seedRow(RIGHT)
    let releaseFirstSend: (() => void) | undefined
    const firstSendReached = new Promise<void>(resolve => {
      releaseFirstSend = resolve
    })
    const deps = makeDeps({
      tmuxPoke: vi.fn(async (a: { pane_id: string }) => {
        if (a.pane_id === LEFT.pane_id) {
          await firstSendReached
          // Returns only after LEFT's row has been overwritten below.
          return { ok: true as const, pane_tail_before: '', pane_tail_after: '' }
        }
        return { ok: true as const, pane_tail_before: '', pane_tail_after: '' }
      }),
    })
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    await vi.advanceTimersByTimeAsync(0)

    // LEFT's row is replaced; the in-flight send above has not returned yet.
    repo.upsert({
      pane_id: LEFT.pane_id,
      xats_agent_id: 'U_LEFT_NEW',
      expires_at: EXPIRES,
    })
    cancelCodexSeedingSchedule(LEFT.pane_id, { reason: 'row_replaced' })
    // A new generation for LEFT mints a replacement token.
    const replacement = mintCodexRecoveryNonce(LEFT.pane_id)

    releaseFirstSend?.()
    await vi.advanceTimersByTimeAsync(0)

    // The stale send completed, but its nonce is gone from the store, so the
    // replacement must still count as undelivered.
    expect(hasDeliveredCodexRecoveryNonce(LEFT.pane_id)).toBe(false)
    expect(resolveCodexRecoveryNonce(replacement)).toBe(LEFT.pane_id)
  })

  it('a send that pasted without executing DOES hold the pane', async () => {
    // The one failure that still wrote: the primitive separates "nothing
    // written" from "pasted but never executed", and in the second case the
    // token is in the pane and can still be quoted back.
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps({
      tmuxPoke: vi.fn(async () => ({ error: 'ownership_lost' as const })),
    })
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    await vi.advanceTimersByTimeAsync(0)

    const third = { pane_id: '%30', uuid: 'U-30', tty: 'ttys030', pid: 3030 }
    seedRow(third)
    const next = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(third), next)

    expect(__peekCodexSeedingSchedules()).toEqual(['%30'])
    expect(logLines(next).join('\n'))
      .toContain('held=%10(token),%20(token)')
  })

  it('the notice asserts no team, no name and no identity key', () => {
    const content = buildCodexSeedingPokeContent({ nonce: 'N-123' })
    expect(content).toContain('register_agent')
    expect(content).toContain('recovery_nonce: "N-123"')
    // The recovery notice's identity assertions, which this one cannot make.
    expect(content).not.toContain('name="')
    expect(content).not.toContain('team="')
    expect(content).not.toMatch(/identity[_ ]key/i)
  })

  it('each pane gets its own token, and each token binds its own row', async () => {
    // The whole chain: ambiguity → token per pane → the registration quoting
    // it consumes ITS OWN row, with no candidate-count refusal anywhere.
    seedRow(LEFT, 'K_LEFT')
    seedRow(RIGHT, 'K_RIGHT')
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(RIGHT, 'K_RIGHT'), deps)
    await vi.advanceTimersByTimeAsync(0)

    const sent = pokeCalls(deps)
    expect(sent.map(c => c.pane_id).sort()).toEqual(['%10', '%20'])
    for (const call of sent) {
      const pane = PANES.find(p => p.pane_id === call.pane_id)!
      // The notice may not carry the row's key, and the token the daemon put
      // in THIS pane must resolve to THIS pane.
      expect(call.content).not.toContain('K_LEFT')
      expect(call.content).not.toContain('K_RIGHT')
      expect(resolveCodexRecoveryNonce(nonceIn(call.content))).toBe(pane.pane_id)
    }

    const log = vi.fn()
    for (const call of sent) {
      const pane = PANES.find(p => p.pane_id === call.pane_id)!
      const callerAgentId = `caller-${pane.pane_id}`
      db.prepare(
        `INSERT INTO agents
           (agent_id, device, team, role, name, registered_at, last_seen_at)
         VALUES (?, 'local', 'lab', 'impl', ?, ?, ?)`
      ).run(
        callerAgentId, `codex${pane.pane_id}`,
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      )
      const targetPaneId = consumeCodexRecoveryNonce(nonceIn(call.content))
      expect(targetPaneId).toBe(pane.pane_id)
      const bound = await autoBindCodexPane(
        {
          callerAgentId,
          repo,
          expectedRegisterGeneration: 1,
          targetPaneId,
          runAtomic: fn => db.transaction(fn)(),
          bindRuntimeIdentitySvc: {
            verify: vi.fn(async () => ({
              ok: true,
              tmux_pane_id: pane.pane_id,
              tty: pane.tty,
              expectedRegisterGeneration: 1,
            })),
            commit: vi.fn(() => ({ ok: true })),
          } as never,
          identityKeyAttach: {
            findCaller: () => ({
              team: 'lab', name: `codex${pane.pane_id}`, identity_key: null,
            }),
            findByIdentityKey: () => [],
            applyPlan: () => {},
            log,
          },
          log,
        },
        {
          listPanes: async () =>
            PANES.map(p => ({ pane_id: p.pane_id, tty: p.tty })),
          ttyProcesses: async (tty: string) => {
            const p = PANES.find(x => x.tty === tty)
            return p ? [fgLine(p)] : []
          },
        }
      )
      expect(bound).toBe('bound_consumed')
    }
    expect(repo.listUnexpired('2026-01-01T00:00:10.000Z')).toEqual([])
    expect(log.mock.calls.map(call => String(call[0]))
      .filter(l => l.includes('candidate_count'))).toEqual([])
  })

  it('a backgrounded carrier at the write checkpoint writes nothing', async () => {
    // Real primitive: the composite confirm runs at the pre-capture, pre-paste
    // and pre-Enter checkpoints, and the pid being alive proves nothing.
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps({
      tmuxPoke: undefined,
      foregroundProbeSync: (tty: string) => {
        const pane = PANES.find(p => p.tty === tty)!
        return [bgLine(pane), FG_SHELL_LINE]
      },
    })
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    // Past the primitive's quiet window (2s) and before the resumed probe's
    // next tick, so the resumed schedule is observable.
    await vi.advanceTimersByTimeAsync(2_500)

    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    // Transient: the pane can return to the foreground, so both generations
    // go back to polling instead of retiring.
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('reason=pane_reassigned action=resume_probe_polling')
    )
    expect(__peekCodexSeedingSchedules().sort()).toEqual(['%10', '%20'])
  })

  it('a foreground carrier delivers end to end, key-free', async () => {
    seedRow(LEFT, 'K_SECRET')
    seedRow(RIGHT, 'K_SECRET_2')
    const deps = makeDeps({ tmuxPoke: undefined })
    evaluateCodexSeedingOnPreRegister(writer(RIGHT, 'K_SECRET_2'), deps)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(2)
    const bodies = vi.mocked(tmuxCli.loadBuffer).mock.calls.map(c => c[1])
    for (const body of bodies) {
      expect(body).toContain('cross-agent-teams pane token')
      expect(body).not.toContain('K_SECRET')
    }
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('codex-seeding delivered: pane=%10')
    )
    expect(__peekCodexSeedingSchedules()).toEqual([])
  })

  it('a row overwritten before the probe cancels the schedule unsent', async () => {
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    // The launcher relaunches %10 with a new uuid while the probe is pending.
    repo.upsert({
      pane_id: LEFT.pane_id, xats_agent_id: 'U_NEW', expires_at: EXPIRES,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(pokeCalls(deps).map(c => c.pane_id)).toEqual(['%20'])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('cancelled: pane=%10 reason=row_replaced')
    )
  })

  it('consuming the row retires the token a delivered notice still quotes', async () => {
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    await vi.advanceTimersByTimeAsync(0)
    const nonce = nonceIn(
      pokeCalls(deps).find(c => c.pane_id === '%10')!.content
    )
    expect(resolveCodexRecoveryNonce(nonce)).toBe('%10')

    // Delivery retires the generation while the token stays outstanding, so
    // the consume-time cancel is the only thing left that can retire it.
    cancelCodexSeedingSchedule('%10', { reason: 'row_consumed', log: deps.log })
    expect(resolveCodexRecoveryNonce(nonce)).toBeUndefined()
  })

  it('cancelling a live schedule stops it and logs the terminal reason', () => {
    seedRow(LEFT)
    seedRow(RIGHT)
    const deps = makeDeps()
    evaluateCodexSeedingOnPreRegister(writer(RIGHT), deps)
    expect(__peekCodexSeedingSchedules().sort()).toEqual(['%10', '%20'])

    cancelCodexSeedingSchedule('%10', { reason: 'row_consumed', log: deps.log })
    expect(__peekCodexSeedingSchedules()).toEqual(['%20'])
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('codex-seeding cancelled: pane=%10 reason=row_consumed')
    )
  })
})
