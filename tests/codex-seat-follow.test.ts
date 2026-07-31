import { describe, it, expect, vi } from 'vitest'
import {
  followSeatIdentityKey,
  type SeatFollowDeps,
} from '../src/mcp/codex-seat-follow.js'
import type { SeatKeyHolder } from '../src/storage/agents-repo.js'

const THREAD_X = '11111111-1111-4111-8111-111111111111'
const THREAD_Y = '22222222-2222-4222-8222-222222222222'

const HOLDER: SeatKeyHolder = {
  agent_id: 'holder-1',
  device: 'local',
  team: 'aoe',
  name: 'X',
  role: 'default',
  runtime_ui_pid: 4242,
  identity_key: 'K1',
  codex_thread_id: THREAD_X,
  last_seen_at: '2026-01-01T00:00:00.000Z',
}

function makeDeps(overrides: Partial<SeatFollowDeps> = {}): SeatFollowDeps {
  return {
    findCaller: () => ({
      team: 'aoe',
      name: 'Y',
      identity_key: null,
      codex_thread_id: THREAD_X,
    }),
    findKeyHoldersBySeat: () => [HOLDER],
    applyPlan: vi.fn(),
    isProcessAlive: () => false,
    log: vi.fn(),
    ...overrides,
  }
}

describe('followSeatIdentityKey', () => {
  it('migrates from an ALIVE holder on codex thread equality (rename)', () => {
    // Same conversation re-registering under a new name: the caller carries
    // the SAME codex-appserver thread the holder row already holds — the
    // only verifiable caller-to-process association.
    const deps = makeDeps({ isProcessAlive: () => true })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).toHaveBeenCalledWith(
      { kind: 'migrate', from_agent_id: 'holder-1' },
      'caller-1',
      'K1'
    )
  })

  it('fails closed on an ALIVE holder when the threads differ', () => {
    // Reviewer repro shape: an UNRELATED codex (different thread) that the
    // pane heuristic handed the holder's pane/pid.  Pid equality is not part
    // of the alive-migrate condition at all — thread mismatch means no move.
    const deps = makeDeps({
      isProcessAlive: () => true,
      findCaller: () => ({
        team: 'aoe',
        name: 'Y',
        identity_key: null,
        codex_thread_id: THREAD_Y,
      }),
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('seat-follow conflict')
    )
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('thread_mismatch')
    )
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('K1'))
  })

  it('fails closed on an ALIVE holder when the caller has no thread', () => {
    const deps = makeDeps({
      isProcessAlive: () => true,
      findCaller: () => ({
        team: 'aoe',
        name: 'Y',
        identity_key: null,
        codex_thread_id: null,
      }),
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('thread_missing')
    )
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('K1'))
  })

  it('fails closed on an ALIVE holder when the holder has no thread', () => {
    const deps = makeDeps({
      isProcessAlive: () => true,
      findKeyHoldersBySeat: () => [{ ...HOLDER, codex_thread_id: null }],
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('thread_missing')
    )
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('K1'))
  })

  it('migrates from a dead holder (same-seat restart), thread not needed', () => {
    const deps = makeDeps({
      isProcessAlive: () => false,
      findCaller: () => ({
        team: 'aoe',
        name: 'Y',
        identity_key: null,
        codex_thread_id: null,
      }),
      findKeyHoldersBySeat: () => [{ ...HOLDER, codex_thread_id: null }],
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).toHaveBeenCalledWith(
      { kind: 'migrate', from_agent_id: 'holder-1' },
      'caller-1',
      'K1'
    )
  })

  it('REGRESSION: a pid-less holder is liveness-UNKNOWN — a different thread never takes its key', () => {
    // Reviewer repro shape: X bound its seat without a pid (verified_tty_pane
    // is a legitimate LIVE state) and holds K1 on thread X; unrelated Y
    // registers with thread Y.  Missing pid must NOT read as dead: X keeps
    // K1, Y gets nothing.
    const deps = makeDeps({
      isProcessAlive: () => true,
      findKeyHoldersBySeat: () => [{ ...HOLDER, runtime_ui_pid: null }],
      findCaller: () => ({
        team: 'aoe',
        name: 'Y',
        identity_key: null,
        codex_thread_id: THREAD_Y,
      }),
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('liveness_unknown')
    )
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('thread_mismatch')
    )
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('K1'))
  })

  it('migrates from a pid-less holder on codex thread equality (rename)', () => {
    // Same conversation renaming itself on a pid-less seat bind: thread
    // equality — the only caller-to-process proof — authorizes the move,
    // and no liveness probe runs (there is no pid to check).
    const probe = vi.fn(() => true)
    const deps = makeDeps({
      isProcessAlive: probe,
      findKeyHoldersBySeat: () => [{ ...HOLDER, runtime_ui_pid: null }],
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(probe).not.toHaveBeenCalled()
    expect(deps.applyPlan).toHaveBeenCalledWith(
      { kind: 'migrate', from_agent_id: 'holder-1' },
      'caller-1',
      'K1'
    )
  })

  it('fails closed on a pid-less holder when the holder has no thread', () => {
    // e.g. a non-codex row holding a key on the same tty: liveness unknown
    // and no thread to compare — the key must stay put.
    const deps = makeDeps({
      findKeyHoldersBySeat: () => [
        { ...HOLDER, runtime_ui_pid: null, codex_thread_id: null },
      ],
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('liveness_unknown')
    )
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('thread_missing')
    )
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('K1'))
  })

  it('skips when the caller already holds a key (seeding idempotence)', () => {
    const deps = makeDeps({
      findCaller: () => ({
        team: 'aoe',
        name: 'Y',
        identity_key: 'K2',
        codex_thread_id: THREAD_X,
      }),
    })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('already holds a key')
    )
  })

  it('is a no-op with a count-only debug line on zero candidates', () => {
    const deps = makeDeps({ findKeyHoldersBySeat: () => [] })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('candidates=0')
    )
  })

  it('is a no-op with a count-only debug line on multiple candidates', () => {
    const other: SeatKeyHolder = {
      ...HOLDER,
      agent_id: 'holder-2',
      name: 'W',
      identity_key: 'K7',
    }
    const deps = makeDeps({ findKeyHoldersBySeat: () => [HOLDER, other] })
    followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('candidates=2')
    )
    for (const call of (deps.log as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).not.toContain('K1')
      expect(String(call[0])).not.toContain('K7')
    }
  })

  it('never throws and redacts the key when applyPlan fails', () => {
    const deps = makeDeps({
      applyPlan: () => { throw new Error('boom while binding K1') },
    })
    expect(
      () => followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    ).not.toThrow()
    const lines = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map(call => String(call[0]))
    const errorLine = lines.find(line => line.includes('seat-follow error'))
    expect(errorLine).toBeDefined()
    expect(errorLine).toContain('[redacted]')
    expect(errorLine).not.toContain('K1')
  })

  it('never throws when the holder lookup itself fails', () => {
    const deps = makeDeps({
      findKeyHoldersBySeat: () => { throw new Error('db gone') },
    })
    expect(
      () => followSeatIdentityKey({ callerAgentId: 'caller-1', deps })
    ).not.toThrow()
    expect(deps.applyPlan).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('seat-follow error')
    )
  })
})
