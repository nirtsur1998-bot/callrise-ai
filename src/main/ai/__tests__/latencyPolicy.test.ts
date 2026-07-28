import { describe, expect, it } from 'vitest'
import { LATENCY_POLICY } from '../types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// M9 fixed live-coaching latency with maxRetries:0 on the Anthropic client -
// this has regressed before. LATENCY_POLICY is the single shared source both
// AnthropicProvider and OpenAIProvider read from (see providers/*.ts's
// `LATENCY_POLICY[req.purpose]`), so asserting the constant covers both by
// construction - they cannot diverge without one of them hardcoding its own
// value, which the source-scan test below also guards against.
describe('coaching-cue latency policy', () => {
  it('never retries and stays fail-fast', () => {
    expect(LATENCY_POLICY['coaching-cue'].maxRetries).toBe(0)
    expect(LATENCY_POLICY['coaching-cue'].timeoutMs).toBeLessThanOrEqual(10_000)
  })

  it('every other purpose is still allowed to retry (this test would also catch someone accidentally zeroing all of them out)', () => {
    for (const purpose of ['summary', 'scorecard', 'tasks', 'other'] as const) {
      expect(LATENCY_POLICY[purpose].maxRetries).toBeGreaterThan(0)
    }
  })
})

describe('both providers read from LATENCY_POLICY (no hardcoded retry values)', () => {
  // A literal `maxRetries: 0` is fine (validateKey's one-off cheap probe
  // intentionally hardcodes zero-retry, unrelated to any purpose). What must
  // never appear is a literal NONZERO retry count on complete()/stream(),
  // which would silently bypass the per-purpose policy for whichever purpose
  // it landed on - including, one day, coaching-cue.
  it('anthropic.ts never hardcodes a nonzero maxRetries', () => {
    const src = readFileSync(join(__dirname, '../providers/anthropic.ts'), 'utf8')
    expect(src).toContain('policy.maxRetries')
    expect(src).not.toMatch(/maxRetries:\s*[1-9]/)
  })

  it('openai.ts never hardcodes a nonzero maxRetries', () => {
    const src = readFileSync(join(__dirname, '../providers/openai.ts'), 'utf8')
    expect(src).toContain('policy.maxRetries')
    expect(src).not.toMatch(/maxRetries:\s*[1-9]/)
  })
})
