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
    for (const purpose of ['summary', 'scorecard', 'tasks', 'other', 'prep-brief'] as const) {
      expect(LATENCY_POLICY[purpose].maxRetries).toBeGreaterThan(0)
    }
  })
})

describe('every provider reads from LATENCY_POLICY (no hardcoded retry values)', () => {
  // A literal `maxRetries: 0` is fine (validateKey's one-off cheap probe
  // intentionally hardcodes zero-retry, unrelated to any purpose). What must
  // never appear is a literal NONZERO retry count on complete()/stream(),
  // which would silently bypass the per-purpose policy for whichever purpose
  // it landed on - including, one day, coaching-cue. M20 added
  // openai-compatible.ts (backs 5 providers) and gemini.ts to this scan.
  const scannedProviderFiles = ['anthropic.ts', 'openai.ts', 'openai-compatible.ts']

  it.each(scannedProviderFiles)('%s never hardcodes a nonzero maxRetries', (file) => {
    const src = readFileSync(join(__dirname, '../providers', file), 'utf8')
    expect(src).toContain('policy.maxRetries')
    expect(src).not.toMatch(/maxRetries:\s*[1-9]/)
  })

  // gemini.ts is a bespoke fetch-based adapter with no SDK-level maxRetries
  // option at all (no retry loop to accidentally reintroduce) - its own
  // per-attempt timeout is combineSignals()'s LATENCY_POLICY[purpose]
  // .timeoutMs, asserted separately below instead of a maxRetries scan.
  it('gemini.ts derives its timeout from LATENCY_POLICY, not a hardcoded value', () => {
    const src = readFileSync(join(__dirname, '../providers/gemini.ts'), 'utf8')
    expect(src).toContain('policy.timeoutMs')
    expect(src).not.toMatch(/maxRetries/)
  })
})
