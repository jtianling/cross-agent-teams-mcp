import { describe, expect, it } from 'vitest'
import { describeRedactedError } from '../src/mcp/log-redact.js'

describe('describeRedactedError', () => {
  it('redacts the key from the message', () => {
    const out = describeRedactedError(new Error('lookup failed for K1'), 'K1')
    expect(out).toBe('Error: lookup failed for [redacted]')
  })

  it('redacts a key that equals the error class name', () => {
    const out = describeRedactedError(new Error('boom'), 'Error')
    expect(out).not.toContain('Error')
    expect(out).toBe('[redacted]: boom')
  })

  it('redacts a key embedded in a custom Error.name', () => {
    const err = new Error('bad state')
    err.name = 'K1BindingError'
    const out = describeRedactedError(err, 'K1')
    expect(out).not.toContain('K1')
    expect(out).toBe('[redacted]BindingError: bad state')
  })

  it('handles non-Error values and null redact value', () => {
    expect(describeRedactedError('plain failure')).toBe('string: plain failure')
    expect(describeRedactedError('has K1 inside', null)).toBe('string: has K1 inside')
  })
})
