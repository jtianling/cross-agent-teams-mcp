import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAllCodexRecoveryNonces, consumeCodexRecoveryNonce,
  hasDeliveredCodexRecoveryNonce, markCodexRecoveryNonceDelivered,
  mintCodexRecoveryNonce, resolveCodexRecoveryNonce,
  takeCodexPaneChallenge,
} from '../src/mcp/codex-recovery-nonce.js'

afterEach(() => {
  clearAllCodexRecoveryNonces()
  vi.useRealTimers()
})

describe('codex challenge expiry', () => {
  it('reports expiry once and does not mark an expired token as delivered', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-27T17:05:57Z')
    const nonce = mintCodexRecoveryNonce('%68', {
      launch_id: 'current-launch', expires_at: '2026-10-27T17:15:57Z',
    })
    vi.setSystemTime('2026-10-27T17:15:57Z')
    markCodexRecoveryNonceDelivered(nonce)
    expect(hasDeliveredCodexRecoveryNonce('%68')).toBe(false)
    expect(takeCodexPaneChallenge(nonce)).toEqual({
      ok: false, reason: 'challenge_expired',
    })
    expect(takeCodexPaneChallenge(nonce)).toEqual({
      ok: false, reason: 'challenge_invalid',
    })
  })

  it('stops authorizing a delivered challenge at its pre-registration deadline', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-27T17:05:57Z')
    const nonce = mintCodexRecoveryNonce('%68', {
      launch_id: '56b6946f-7a63-4c29-9304-df7a232dbb54',
      expires_at: '2026-10-27T17:15:57Z',
    })
    markCodexRecoveryNonceDelivered(nonce)
    expect(hasDeliveredCodexRecoveryNonce('%68')).toBe(true)
    vi.setSystemTime('2026-10-27T17:15:57Z')
    expect(hasDeliveredCodexRecoveryNonce('%68')).toBe(false)
    expect(resolveCodexRecoveryNonce(nonce)).toBeUndefined()
    expect(consumeCodexRecoveryNonce(nonce)).toBeUndefined()
  })
})
