import { describe, expect, it } from 'vitest'
import { LATENCY_POLICY, SAME_MODEL_RETRY_LIMIT } from '../types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// M9 fixed live-coaching latency with maxRetries:0 on the Anthropic client -
// this has regressed before. M24 added 'deal-tier1' as a second live,
// latency-critical purpose - same fail-fast shape as coaching-cue.
//
// BUG-058/BUG-059 — `LatencyPolicyEntry.maxRetries` was REMOVED, not just
// unused: the SDK's own retry slept on an uncapped, unabortable wait driven
// by the provider's Retry-After header, and every SDK call site now
// hardcodes maxRetries:0 literally. Retry budget lives in
// SAME_MODEL_RETRY_LIMIT instead, spent by completeWithFallback's own
// abortable loop.
//
// This file's own source-scan assertions were the hollow-green this
// milestone found the hard way: `expect(src).toContain('policy.maxRetries')`
// kept passing after the code was changed to never read that field, because
// this file's own DOC COMMENTS in providers/*.ts happened to contain the
// literal substring "policy.maxRetries" — the test was checking the source
// text, not the code's actual behavior, and a comment satisfies a substring
// match exactly as well as real code does. Every source-scan below now
// strips comments first, so a comment can never again make one of these
// assertions pass for the wrong reason.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('coaching-cue / deal-tier1 latency policy', () => {
  it.each(['coaching-cue', 'deal-tier1'] as const)(
    '%s never retries the same model and stays fail-fast',
    (purpose) => {
      expect(SAME_MODEL_RETRY_LIMIT[purpose]).toBe(0)
      expect(LATENCY_POLICY[purpose].timeoutMs).toBeLessThanOrEqual(10_000)
    }
  )

  it('every other purpose still gets at least one same-model retry (would also catch someone zeroing them all out)', () => {
    for (const purpose of [
      'summary',
      'scorecard',
      'tasks',
      'other',
      'prep-brief',
      'deal-tier2',
      'coaching-chat',
      'memory-extract',
      'memory-consolidate',
      'memory-reflect'
    ] as const) {
      expect(SAME_MODEL_RETRY_LIMIT[purpose]).toBeGreaterThan(0)
    }
  })
})

describe('BUG-058/BUG-059 — no same-model retry can consume the whole HARD_CEILING_MS budget', () => {
  // The concrete finding that forced SAME_MODEL_RETRY_LIMIT to exist as its
  // own, independently-chosen constant rather than inheriting the old
  // maxRetries numbers: for summary/scorecard/deal-tier2/memory-consolidate/
  // memory-reflect, (1 + old maxRetries) * timeoutMs came out to EXACTLY
  // their HARD_CEILING_MS (180s == 180s) — one model's own retries could
  // have consumed the entire ceiling, leaving zero room for the cross-model
  // fallback this milestone exists to provide. This test pins the corrected
  // invariant so nobody re-widens SAME_MODEL_RETRY_LIMIT without noticing.
  it('every purpose keeps real margin between worst-case single-step time and its ceiling', async () => {
    const { HARD_CEILING_MS } = await import('../types')
    const ALL_PURPOSES = Object.keys(HARD_CEILING_MS) as (keyof typeof HARD_CEILING_MS)[]
    for (const purpose of ALL_PURPOSES) {
      const worstCaseMs = (1 + SAME_MODEL_RETRY_LIMIT[purpose]) * LATENCY_POLICY[purpose].timeoutMs
      const ceiling = HARD_CEILING_MS[purpose]
      // At least 4 real seconds of margin for the rest of the chain to be
      // attempted at all — not a generous bar, just "not exactly zero".
      expect(ceiling - worstCaseMs).toBeGreaterThanOrEqual(4_000)
    }
  })
})

describe('every provider hardcodes maxRetries: 0 in real code (not a comment)', () => {
  // A literal `maxRetries: 0` is required at every completion/stream call
  // site — the SDK must never retry again, full stop. What must never
  // appear IN CODE is a nonzero literal, which would silently reintroduce
  // an SDK-owned, unabortable retry for whichever purpose it landed on —
  // including, one day, coaching-cue.
  const scannedProviderFiles = ['anthropic.ts', 'openai.ts', 'openai-compatible.ts']

  it.each(scannedProviderFiles)('%s never hardcodes a nonzero maxRetries, in code', (file) => {
    const code = stripComments(readFileSync(join(__dirname, '../providers', file), 'utf8'))
    expect(code).not.toMatch(/maxRetries:\s*[1-9]/)
  })

  it.each(scannedProviderFiles)('%s actually hardcodes maxRetries: 0 in code (not merely absent)', (file) => {
    const code = stripComments(readFileSync(join(__dirname, '../providers', file), 'utf8'))
    // At least the complete()/stream() call sites plus validateKey's own
    // pre-existing zero-retry probe.
    const occurrences = code.match(/maxRetries:\s*0/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(2)
  })

  it.each(scannedProviderFiles)('%s never references a LatencyPolicyEntry.maxRetries field (it was removed)', (file) => {
    const code = stripComments(readFileSync(join(__dirname, '../providers', file), 'utf8'))
    expect(code).not.toContain('.maxRetries')
  })

  // gemini.ts is a bespoke fetch-based adapter with no SDK-level maxRetries
  // option at all (no retry loop to accidentally reintroduce) - its own
  // per-attempt timeout is combineSignals()'s LATENCY_POLICY[purpose]
  // .timeoutMs, asserted separately below instead of a maxRetries scan.
  it('gemini.ts derives its timeout from LATENCY_POLICY, not a hardcoded value', () => {
    const code = stripComments(readFileSync(join(__dirname, '../providers/gemini.ts'), 'utf8'))
    expect(code).toContain('policy.timeoutMs')
    expect(code).not.toMatch(/maxRetries/)
  })
})
