// BUG-057 Phase 3 — summarizeExhaustion() replaces AllModelsExhaustedError's
// old flat reason-code join (`attempts.map(a => a.reason).join('; ')`) with
// the founder's explicit ask: exactly one of three actions, always. Pure
// function, no SDK — direct unit tests.
import { describe, expect, it } from 'vitest'
import { summarizeExhaustion } from '../complete-with-fallback'

describe('summarizeExhaustion', () => {
  it('every attempt reason starts with auth -> add-key, naming the key problem', () => {
    const result = summarizeExhaustion([
      { reason: 'auth' },
      { reason: 'auth: Your API key was rejected.' }
    ])
    expect(result.kind).toBe('add-key')
    expect(result.message).toMatch(/check your api keys/i)
  })

  it('every attempt classified structural -> bug', () => {
    const result = summarizeExhaustion([
      { reason: 'failed: tool_use_failed', failureClass: 'structural' },
      { reason: 'failed: malformed schema', failureClass: 'structural' }
    ])
    expect(result.kind).toBe('bug')
    expect(result.message).toMatch(/bug/i)
  })

  it('some period-exhausted and none transient -> add-key, naming the quota problem (distinct message from auth)', () => {
    const result = summarizeExhaustion([
      { reason: 'rate-limit', failureClass: 'period-exhausted' },
      { reason: 'failed', failureClass: 'structural' }
    ])
    expect(result.kind).toBe('add-key')
    expect(result.message).toMatch(/free-tier limit/i)
    expect(result.message).not.toMatch(/rejected/i) // not the auth message
  })

  it('any transient attempt present -> wait, even alongside period-exhausted/structural ones', () => {
    const result = summarizeExhaustion([
      { reason: 'rate-limit', failureClass: 'period-exhausted' },
      { reason: 'network', failureClass: 'transient' }
    ])
    expect(result.kind).toBe('wait')
  })

  it('a mix with no confident signal (all transient, the ordinary case) -> wait', () => {
    const result = summarizeExhaustion([
      { reason: 'network', failureClass: 'transient' },
      { reason: 'timeout', failureClass: 'transient' }
    ])
    expect(result.kind).toBe('wait')
  })

  it('failureClass omitted on every attempt defaults to transient, not structural -> wait, not bug', () => {
    // Mirrors AIProviderError call sites where nothing classified the
    // failure — must NOT read as "every model agrees it's a bug".
    const result = summarizeExhaustion([{ reason: 'failed' }, { reason: 'failed' }])
    expect(result.kind).toBe('wait')
  })

  it('auth check wins over failureClass even when every attempt is ALSO structural', () => {
    // auth branches across all 4 providers set failureClass:'structural' too
    // (see failure-class.ts wiring) -- the raw reason string must win so an
    // all-revoked-keys chain reads as "add/fix a key," not "report a bug."
    const result = summarizeExhaustion([
      { reason: 'auth', failureClass: 'structural' },
      { reason: 'auth: rejected', failureClass: 'structural' }
    ])
    expect(result.kind).toBe('add-key')
    expect(result.message).toMatch(/check your api keys/i)
  })

  it('an empty attempts array does not vacuously claim "every key was rejected"', () => {
    // .every() over [] is vacuously true in JS -- without an explicit guard
    // this would incorrectly match the all-auth branch above for a case
    // where nothing was ever actually attempted (e.g. every chain entry's
    // key went missing mid-loop, a real if unlikely path the walker's own
    // comment already flags as possible).
    const result = summarizeExhaustion([])
    expect(result.kind).toBe('wait')
    expect(result.message).not.toMatch(/rejected/i)
    expect(result.message).not.toMatch(/bug/i)
  })
})
