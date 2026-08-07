import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  scheduleKimiRetry,
  cancelKimiRetry,
  clearAllKimiRetries,
  __peekKimiRetryMap,
  KIMI_RETRY_DELAYS_MS,
  type KimiRetryContext,
  type KimiPokeAttemptResult,
} from '../src/mcp/kimi-poke-retry.js'
import { RETRY_DELAYS_MS } from '../src/mcp/poke-retry.js'
import { fanoutAutoPoke, type AutoPokeSkipReason } from '../src/mcp/auto-poke-fanout.js'

interface StatusCall {
  agentId: string
  wake_status: string
  skip_reason?: string | null
  retry_attempts?: number
}

function makeCtx(overrides: Partial<KimiRetryContext> = {}): KimiRetryContext {
  const base: KimiRetryContext = {
    agentId: 'K',
    messageId: 'm1',
    attemptFn: async () => ({ ok: false, reason: 'kimi_session_busy' }),
  }
  return { ...base, ...overrides }
}

describe('kimi-poke-retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearAllKimiRetries()
  })
  afterEach(() => {
    clearAllKimiRetries()
    vi.useRealTimers()
  })

  it('shares the tmux delay ladder rather than defining its own', () => {
    expect(KIMI_RETRY_DELAYS_MS).toBe(RETRY_DELAYS_MS)
    expect([...KIMI_RETRY_DELAYS_MS]).toEqual([30_000, 180_000, 600_000])
  })

  it('keys entries as ${messageId}:${agentId}', () => {
    scheduleKimiRetry(makeCtx())
    expect(__peekKimiRetryMap().has('m1:K')).toBe(true)
  })

  it('re-runs the precondition attempt at 30s, 180s and 600s', async () => {
    const at: number[] = []
    let elapsed = 0
    scheduleKimiRetry(
      makeCtx({
        attemptFn: async () => {
          at.push(elapsed)
          return { ok: false, reason: 'kimi_session_busy' }
        },
      })
    )
    elapsed = 30_000
    await vi.advanceTimersByTimeAsync(30_000)
    expect(at).toEqual([30_000])
    elapsed = 210_000
    await vi.advanceTimersByTimeAsync(180_000)
    expect(at).toEqual([30_000, 210_000])
    elapsed = 810_000
    await vi.advanceTimersByTimeAsync(600_000)
    expect(at).toEqual([30_000, 210_000, 810_000])
  })

  it('stops the ladder when a retry succeeds', async () => {
    const results: KimiPokeAttemptResult[] = [
      { ok: false, reason: 'kimi_session_busy' },
      { ok: true },
    ]
    let calls = 0
    const statusCalls: StatusCall[] = []
    scheduleKimiRetry(
      makeCtx({
        attemptFn: async () => results[calls++] ?? { ok: true },
        updateStatusFn: s => { statusCalls.push(s) },
      })
    )
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls).toBe(2)
    expect(__peekKimiRetryMap().size).toBe(0)
    expect(statusCalls.at(-1)).toMatchObject({
      agentId: 'K',
      wake_status: 'delivered',
      skip_reason: null,
    })
  })

  it('takes no further action once the gradient is exhausted', async () => {
    let calls = 0
    const statusCalls: StatusCall[] = []
    scheduleKimiRetry(
      makeCtx({
        attemptFn: async () => {
          calls += 1
          return { ok: false, reason: 'kimi_session_busy' }
        },
        updateStatusFn: s => { statusCalls.push(s) },
      })
    )
    await vi.advanceTimersByTimeAsync(30_000 + 180_000 + 600_000)
    expect(calls).toBe(3)
    // No forced injection, no tmux fallback, no fourth attempt.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls).toBe(3)
    expect(__peekKimiRetryMap().size).toBe(0)
    expect(statusCalls.at(-1)).toMatchObject({
      agentId: 'K',
      wake_status: 'failed',
      skip_reason: 'retry_exhausted',
      retry_attempts: 3,
    })
  })

  it('abandons the ladder on a non-busy failure instead of burning retries', async () => {
    let calls = 0
    scheduleKimiRetry(
      makeCtx({
        attemptFn: async () => {
          calls += 1
          return { ok: false, reason: 'kimi_pending_interaction' }
        },
      })
    )
    await vi.advanceTimersByTimeAsync(30_000 + 180_000 + 600_000)
    expect(calls).toBe(1)
    expect(__peekKimiRetryMap().size).toBe(0)
  })

  it('cancelKimiRetry removes a pending entry', async () => {
    let calls = 0
    scheduleKimiRetry(makeCtx({ attemptFn: async () => { calls += 1; return { ok: true } } }))
    cancelKimiRetry('m1:K')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toBe(0)
    expect(__peekKimiRetryMap().size).toBe(0)
  })

  it('stops the ladder without attempting when the mail was already read', async () => {
    let calls = 0
    const statusCalls: StatusCall[] = []
    scheduleKimiRetry(
      makeCtx({
        alreadyReadFn: () => true,
        attemptFn: async () => { calls += 1; return { ok: true } },
        updateStatusFn: s => { statusCalls.push(s) },
      })
    )
    await vi.advanceTimersByTimeAsync(30_000 + 180_000 + 600_000)
    expect(calls).toBe(0)
    expect(__peekKimiRetryMap().size).toBe(0)
    expect(statusCalls).toEqual([
      { agentId: 'K', wake_status: 'skipped', skip_reason: 'already_read', retry_attempts: 0 },
    ])
  })
})

describe('fanoutAutoPoke kimi deferral scheduling', () => {
  const KIMI_RECIPIENT = {
    agent_id: 'K',
    tmux_pane_id: null,
    delivery: {
      kind: 'kimi-server' as const,
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
    },
  }

  async function runFanout(reason: AutoPokeSkipReason) {
    const kimiScheduled: KimiRetryContext[] = []
    const tmuxScheduled: unknown[] = []
    const result = await fanoutAutoPoke({
      team: 'default',
      fromAgentId: 'A',
      recipients: [KIMI_RECIPIENT],
      body: 'hi',
      deps: { poke: async () => ({ ok: false, reason }), tmuxAvailable: async () => true },
      retry: {
        messageId: 'm1',
        sentAt: '2020-01-01T00:00:00.000Z',
        lookupAgentFn: () => undefined,
        scheduleRetryFn: ctx => { tmuxScheduled.push(ctx) },
        scheduleKimiRetryFn: ctx => { kimiScheduled.push(ctx) },
      },
    })
    return { result, kimiScheduled, tmuxScheduled }
  }

  it('schedules a kimi retry for kimi_session_busy and never a tmux retry', async () => {
    const { result, kimiScheduled, tmuxScheduled } = await runFanout('kimi_session_busy')
    expect(kimiScheduled).toHaveLength(1)
    expect(kimiScheduled[0]).toMatchObject({ agentId: 'K', messageId: 'm1' })
    expect(tmuxScheduled).toHaveLength(0)
    expect(result.retryScheduledCount).toBe(1)
    expect(result.skipReasons).toEqual([{ agent_id: 'K', reason: 'kimi_session_busy' }])
  })

  it('schedules nothing for kimi_pending_interaction', async () => {
    const { result, kimiScheduled, tmuxScheduled } = await runFanout('kimi_pending_interaction')
    expect(kimiScheduled).toHaveLength(0)
    expect(tmuxScheduled).toHaveLength(0)
    expect(result.retryScheduledCount).toBe(0)
    expect(result.skipReasons).toEqual([
      { agent_id: 'K', reason: 'kimi_pending_interaction' },
    ])
  })

  it('re-pokes the same recipient when the scheduled kimi retry attempt runs', async () => {
    const pokeCalls: Array<{ targetAgentId: string; paneId: string | null }> = []
    const kimiScheduled: KimiRetryContext[] = []
    await fanoutAutoPoke({
      team: 'default',
      fromAgentId: 'A',
      recipients: [KIMI_RECIPIENT],
      body: 'hi',
      deps: {
        poke: async args => {
          pokeCalls.push({ targetAgentId: args.targetAgentId, paneId: args.paneId })
          return { ok: false, reason: 'kimi_session_busy' as AutoPokeSkipReason }
        },
        tmuxAvailable: async () => true,
      },
      retry: {
        messageId: 'm1',
        sentAt: '2020-01-01T00:00:00.000Z',
        lookupAgentFn: () => undefined,
        scheduleKimiRetryFn: ctx => { kimiScheduled.push(ctx) },
      },
    })
    expect(pokeCalls).toHaveLength(1)
    const attempt = await kimiScheduled[0].attemptFn()
    expect(attempt).toEqual({ ok: false, reason: 'kimi_session_busy' })
    expect(pokeCalls).toHaveLength(2)
    expect(pokeCalls[1]).toEqual({ targetAgentId: 'K', paneId: null })
  })
})
