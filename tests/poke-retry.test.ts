import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  scheduleRetry,
  cancelRetry,
  clearAllRetries,
  __peekRetryMap,
  type RetryContext
} from '../src/mcp/poke-retry.js'

interface PokeCall { paneId: string; body: string; targetAgentId: string }
interface StatusCall {
  agentId: string
  wake_status: string
  skip_reason?: string | null
  retry_attempts?: number
}

function makeCtx(overrides: Partial<RetryContext>): RetryContext {
  const base: RetryContext = {
    agentId: 'B',
    messageId: 'm1',
    fromAgentId: 'A',
    body: 'hi',
    team: 'default',
    sentAt: '2020-01-01T00:00:00.000Z',
    paneId: '%2',
    paneGuardFn: async () => 'fail',
    pokeFn: async () => { /* noop */ },
    lookupAgentFn: () => ({ agent_id: 'B', tmux_pane_id: '%2', last_seen_at: '2019-12-31T00:00:00.000Z' })
  }
  return { ...base, ...overrides }
}

describe('poke-retry core', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearAllRetries()
  })
  afterEach(() => {
    clearAllRetries()
    vi.useRealTimers()
  })

  it('schedules an entry with key ${messageId}:${agentId}', () => {
    scheduleRetry(makeCtx({}))
    const map = __peekRetryMap()
    expect(map.size).toBe(1)
    expect(map.has('m1:B')).toBe(true)
  })

  it('advances 30s with guard pass → pokeFn called once; map empty', async () => {
    const pokeCalls: PokeCall[] = []
    const statusCalls: StatusCall[] = []
    scheduleRetry(makeCtx({
      paneGuardFn: async () => 'pass',
      pokeFn: async (a) => { pokeCalls.push({ paneId: a.paneId, body: a.body, targetAgentId: a.targetAgentId }) },
      updateStatusFn: (s) => { statusCalls.push(s) }
    }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pokeCalls.length).toBe(1)
    expect(pokeCalls[0]).toEqual({ paneId: '%2', body: 'hi', targetAgentId: 'B' })
    expect(statusCalls.at(-1)).toMatchObject({
      agentId: 'B',
      wake_status: 'delivered',
      retry_attempts: 1,
    })
    expect(__peekRetryMap().size).toBe(0)
  })

  it('advance 30s guard fail, then 180s guard pass → poke at t=210s only', async () => {
    const pokeCalls: PokeCall[] = []
    let callNum = 0
    scheduleRetry(makeCtx({
      paneGuardFn: async () => {
        callNum++
        return callNum === 1 ? 'fail' : 'pass'
      },
      pokeFn: async (a) => { pokeCalls.push({ paneId: a.paneId, body: a.body, targetAgentId: a.targetAgentId }) }
    }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pokeCalls.length).toBe(0)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(pokeCalls.length).toBe(1)
    expect(__peekRetryMap().size).toBe(0)
  })

  it('all 3 guards fail → no poke fire, map empty after 610s', async () => {
    const pokeCalls: PokeCall[] = []
    const statusCalls: StatusCall[] = []
    scheduleRetry(makeCtx({
      paneGuardFn: async () => 'fail',
      pokeFn: async (a) => { pokeCalls.push({ paneId: a.paneId, body: a.body, targetAgentId: a.targetAgentId }) },
      updateStatusFn: (s) => { statusCalls.push(s) }
    }))
    await vi.advanceTimersByTimeAsync(30_000 + 180_000 + 600_000 + 10)
    expect(pokeCalls.length).toBe(0)
    expect(statusCalls.at(-1)).toMatchObject({
      agentId: 'B',
      wake_status: 'failed',
      skip_reason: 'retry_exhausted',
      retry_attempts: 3,
    })
    expect(__peekRetryMap().size).toBe(0)
  })

  it('lookupAgentFn reports last_seen_at > sentAt at retry tick → cancels remaining', async () => {
    const pokeCalls: PokeCall[] = []
    const statusCalls: StatusCall[] = []
    let callNum = 0
    scheduleRetry(makeCtx({
      sentAt: '2020-01-01T00:00:00.000Z',
      paneGuardFn: async () => 'fail',
      pokeFn: async (a) => { pokeCalls.push({ paneId: a.paneId, body: a.body, targetAgentId: a.targetAgentId }) },
      updateStatusFn: (s) => { statusCalls.push(s) },
      lookupAgentFn: () => {
        callNum++
        if (callNum === 1) {
          return { agent_id: 'B', tmux_pane_id: '%2', last_seen_at: '2020-01-01T00:05:00.000Z' }
        }
        return { agent_id: 'B', tmux_pane_id: '%2', last_seen_at: '2019-12-31T00:00:00.000Z' }
      }
    }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pokeCalls.length).toBe(0)
    expect(statusCalls.at(-1)).toMatchObject({
      agentId: 'B',
      wake_status: 'skipped',
      skip_reason: 'recipient_active',
    })
    expect(__peekRetryMap().size).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(pokeCalls.length).toBe(0)
  })

  it('clearAllRetries after schedule → map empty, no tick fires', async () => {
    const pokeCalls: PokeCall[] = []
    scheduleRetry(makeCtx({
      paneGuardFn: async () => 'pass',
      pokeFn: async () => { pokeCalls.push({ paneId: '%2', body: 'hi', targetAgentId: 'B' }) }
    }))
    expect(__peekRetryMap().size).toBe(1)
    clearAllRetries()
    expect(__peekRetryMap().size).toBe(0)
    await vi.advanceTimersByTimeAsync(800_000)
    expect(pokeCalls.length).toBe(0)
  })

  it('cancelRetry(key) removes the pending entry', async () => {
    const pokeCalls: PokeCall[] = []
    scheduleRetry(makeCtx({
      paneGuardFn: async () => 'pass',
      pokeFn: async () => { pokeCalls.push({ paneId: '%2', body: 'hi', targetAgentId: 'B' }) }
    }))
    expect(__peekRetryMap().has('m1:B')).toBe(true)
    cancelRetry('m1:B')
    expect(__peekRetryMap().has('m1:B')).toBe(false)
    await vi.advanceTimersByTimeAsync(800_000)
    expect(pokeCalls.length).toBe(0)
  })

  it('alreadyReadFn true at tick → no guard/poke, status skipped already_read', async () => {
    let guardCalls = 0
    const pokeCalls: PokeCall[] = []
    const statusCalls: StatusCall[] = []
    scheduleRetry(makeCtx({
      alreadyReadFn: () => true,
      paneGuardFn: async () => { guardCalls += 1; return 'pass' },
      pokeFn: async (a) => { pokeCalls.push({ paneId: a.paneId, body: a.body, targetAgentId: a.targetAgentId }) },
      updateStatusFn: (s) => { statusCalls.push(s) }
    }))
    await vi.advanceTimersByTimeAsync(30_000 + 180_000 + 600_000)
    expect(guardCalls).toBe(0)
    expect(pokeCalls.length).toBe(0)
    expect(__peekRetryMap().size).toBe(0)
    expect(statusCalls).toEqual([
      { agentId: 'B', wake_status: 'skipped', skip_reason: 'already_read', retry_attempts: 0 }
    ])
  })
})
