import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAllCodexRecoveryNonces,
  clearCodexRecoveryNoncesForPane,
  consumeCodexRecoveryNonce,
  mintCodexRecoveryNonce,
  resolveCodexRecoveryNonce,
} from '../src/mcp/codex-recovery-nonce.js'
import {
  buildCodexRecoveryPokeContent,
  cancelCodexRecoverySchedule,
} from '../src/mcp/codex-recovery-poke.js'

describe('codex recovery nonce registry', () => {
  afterEach(() => { clearAllCodexRecoveryNonces() })

  it('a nonce names the pane it was issued for, and two panes never collide', () => {
    const a = mintCodexRecoveryNonce('%10')
    const b = mintCodexRecoveryNonce('%20')
    expect(a).not.toBe(b)
    expect(resolveCodexRecoveryNonce(a)).toBe('%10')
    expect(resolveCodexRecoveryNonce(b)).toBe('%20')
  })

  it('spending a nonce is single use', () => {
    // A token that stayed valid could re-target a LATER registration at a pane
    // whose row someone else has since consumed.
    const nonce = mintCodexRecoveryNonce('%10')
    expect(consumeCodexRecoveryNonce(nonce)).toBe('%10')
    expect(consumeCodexRecoveryNonce(nonce)).toBeUndefined()
    expect(resolveCodexRecoveryNonce(nonce)).toBeUndefined()
  })

  it('minting again for the same pane invalidates the previous nonce', () => {
    // A newer recovery generation supersedes the older one; leaving the old
    // token valid would let a stale poke select a row the newer generation has
    // already moved past.
    const old = mintCodexRecoveryNonce('%10')
    const fresh = mintCodexRecoveryNonce('%10')
    expect(fresh).not.toBe(old)
    expect(resolveCodexRecoveryNonce(old)).toBeUndefined()
    expect(resolveCodexRecoveryNonce(fresh)).toBe('%10')
  })

  it('clearing a pane drops its nonce and leaves other panes alone', () => {
    const a = mintCodexRecoveryNonce('%10')
    const b = mintCodexRecoveryNonce('%20')
    clearCodexRecoveryNoncesForPane('%10')
    expect(resolveCodexRecoveryNonce(a)).toBeUndefined()
    expect(resolveCodexRecoveryNonce(b)).toBe('%20')
  })

  it('the recovery notice quotes the token, and says nothing about it without one', () => {
    // The caller cannot work out its own pane (its tools run in a shared
    // app-server), so the notice carrying the token IS the correlation.
    const withNonce = buildCodexRecoveryPokeContent({
      team: 'aoe', name: 'aoe-codex', nonce: 'N-123',
    })
    expect(withNonce).toContain('recovery_nonce: "N-123"')
    expect(withNonce).toContain('copy that value exactly')

    const without = buildCodexRecoveryPokeContent({ team: 'aoe', name: 'aoe-codex' })
    expect(without).not.toContain('recovery_nonce')
    expect(without).toContain('register_agent')
  })

  it('cancelling a pane schedule invalidates that pane token', () => {
    // The token belongs to the schedule: once the row is consumed, replaced or
    // expired, a surviving nonce would still point at this pane.
    const nonce = mintCodexRecoveryNonce('%77')
    expect(resolveCodexRecoveryNonce(nonce)).toBe('%77')
    cancelCodexRecoverySchedule('%77')
    expect(resolveCodexRecoveryNonce(nonce)).toBeUndefined()
  })

  it('an unknown nonce resolves to nothing rather than throwing', () => {
    // The register path must be able to treat a stale or invented token as
    // "no correlation offered" and fall back, never as an error.
    expect(resolveCodexRecoveryNonce('not-a-nonce')).toBeUndefined()
    expect(consumeCodexRecoveryNonce('not-a-nonce')).toBeUndefined()
  })
})
