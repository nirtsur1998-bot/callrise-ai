// BUG-148 — a rejected default provider stops being attempt #1 on every call.
//
// Built on resolveChain.legacy.test.ts's setup, for the same reason that file
// exists: resolveChain.test.ts mocks `getActiveAIProvider: () => null` at module
// scope, which mocks the entire legacy branch — the branch this bug lives in —
// out of existence.
//
// ── EVERY ASSERTION HERE IS ABOUT ORDER, NOT MEMBERSHIP ──────────────────
//
// The property this change alters is WHICH STEP IS ATTEMPTED FIRST. Membership
// is deliberately unchanged for durable purposes: demotion reorders, it does not
// remove, so `toContain`-shaped assertions pass identically before and after and
// would discriminate NOTHING. That is not a hypothetical — a `toEqual(['groq'])`
// → `toContain('groq')` "correction" in this codebase on 2026-08-30 was called
// corrected-not-relaxed in good faith and distinguished nothing, for exactly
// this reason. So: index-based assertions, and a membership control that proves
// membership alone cannot tell the two states apart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIPurpose } from '../types'

const activeProviderId = { current: 'groq' as string | null }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))

const { loadAppSettings } = await import('../../app-settings')
const { resolveConfiguredChain } = await import('../complete-with-fallback')
const {
  noteAuthRejection,
  clearDemotion,
  isDemoted,
  demotionState,
  resetDemotionsForTests,
  DEMOTION_THRESHOLD,
  DEMOTION_TTL_MS
} = await import('../provider-demotion')

const ALL_PURPOSES: AIPurpose[] = [
  'coaching-cue',
  'summary',
  'scorecard',
  'tasks',
  'other',
  'prep-brief',
  'deal-tier1',
  'deal-tier2',
  'coaching-chat',
  'assistant-chat',
  'memory-extract',
  'memory-consolidate',
  'memory-reflect'
]

function allEmpty(): ReturnType<typeof loadAppSettings> {
  const aiModelAssignments = Object.fromEntries(ALL_PURPOSES.map((p) => [p, { chain: [] }]))
  return { aiModelAssignments } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetDemotionsForTests()
  activeProviderId.current = 'groq'
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
  // Several keyed providers, so a real tail exists to demote behind.
  process.env.GROQ_API_KEY = 'g'
  process.env.GOOGLE_AI_API_KEY = 'goo'
  process.env.OPENROUTER_API_KEY = 'or'
  process.env.CEREBRAS_API_KEY = 'c'
})

afterEach(() => {
  resetDemotionsForTests()
  process.env = { ...ORIGINAL_ENV }
})

/** One walk's worth of auth rejection, repeated. The walk itself de-duplicates
 *  per provider, so each call here stands for a separate call. */
function rejectTimes(providerId: string, times: number, at = Date.now()): void {
  for (let i = 0; i < times; i++) noteAuthRejection(providerId as never, at)
}

describe('the demotion record itself', () => {
  it('one rejection is not enough — a single misclassified error must not demote', () => {
    rejectTimes('groq', 1)
    expect(isDemoted('groq' as never, Date.now())).toBe(false)
  })

  it(`${DEMOTION_THRESHOLD} rejections demote`, () => {
    rejectTimes('groq', DEMOTION_THRESHOLD)
    expect(isDemoted('groq' as never, Date.now())).toBe(true)
  })

  it('a success clears it outright, not partially', () => {
    rejectTimes('groq', DEMOTION_THRESHOLD)
    clearDemotion('groq' as never)
    expect(isDemoted('groq' as never, Date.now())).toBe(false)
    // And the COUNT is gone too: one later rejection must not re-demote
    // instantly off a surviving tally.
    rejectTimes('groq', 1)
    expect(isDemoted('groq' as never, Date.now())).toBe(false)
  })

  it('the record ages out, and its count ages out with it', () => {
    const t0 = 1_000_000
    rejectTimes('groq', 1, t0)
    // One rejection, then a very long gap, then another. Two rejections total,
    // but never two within one TTL window — so this must NOT be a demotion.
    // A naive counter that never expired would demote here.
    rejectTimes('groq', 1, t0 + DEMOTION_TTL_MS + 1)
    expect(isDemoted('groq' as never, t0 + DEMOTION_TTL_MS + 1)).toBe(false)
  })

  it('reports when it began, for the UI to show', () => {
    const t0 = 5_000_000
    rejectTimes('groq', DEMOTION_THRESHOLD, t0)
    expect(demotionState('groq' as never, t0)).toMatchObject({ demoted: true, demotedAt: t0 })
  })
})

describe('a durable purpose: the demoted step moves to the BACK, and stays in the chain', () => {
  it('normally leads with the legacy step', () => {
    const chain = resolveConfiguredChain('summary')
    expect(chain[0].providerId).toBe('groq')
    expect(chain[0].catalogId).toBe('legacy:groq')
  })

  it('after demotion it is LAST — and it is still there', () => {
    const before = resolveConfiguredChain('summary')
    rejectTimes('groq', DEMOTION_THRESHOLD)
    const after = resolveConfiguredChain('summary')

    expect(after[0].catalogId).not.toBe('legacy:groq')
    expect(after[after.length - 1].catalogId).toBe('legacy:groq')

    // "Reorder, never remove" — asserted, because it is the property that
    // keeps the demoted provider reachable and therefore restorable.
    expect(after).toHaveLength(before.length)
    expect([...after].map((s) => s.catalogId).sort()).toEqual(
      [...before].map((s) => s.catalogId).sort()
    )
  })

  it('CONTROL: membership alone cannot tell the two states apart', () => {
    // The point of this test is to FAIL the naive check, proving that any
    // assertion in this suite written as `toContain` is blind to this change.
    // If this ever goes red, membership started differing and the reasoning
    // above needs revisiting.
    const before = resolveConfiguredChain('summary').map((s) => s.catalogId)
    rejectTimes('groq', DEMOTION_THRESHOLD)
    const after = resolveConfiguredChain('summary').map((s) => s.catalogId)

    for (const id of before) expect(after).toContain(id)
    expect(before).not.toEqual(after) // ...yet the ORDER did change.
  })

  it('a cleared demotion restores the original order exactly', () => {
    const before = resolveConfiguredChain('summary').map((s) => s.catalogId)
    rejectTimes('groq', DEMOTION_THRESHOLD)
    clearDemotion('groq' as never)
    expect(resolveConfiguredChain('summary').map((s) => s.catalogId)).toEqual(before)
  })
})

describe('the live purposes (LEGACY_TAIL_MAX 0): decision 5B', () => {
  it('normally the chain is exactly the legacy step', () => {
    const chain = resolveConfiguredChain('coaching-cue')
    expect(chain).toHaveLength(1)
    expect(chain[0].catalogId).toBe('legacy:groq')
  })

  it('a demoted default is REPLACED, and the chain is still one step long', () => {
    // The live budget is what CHAIN_BUDGET protects: one attempt, six seconds.
    // 5B does not spend a second attempt — it changes which single attempt is
    // bought, from one we have evidence cannot succeed to one that might.
    rejectTimes('groq', DEMOTION_THRESHOLD)
    const chain = resolveConfiguredChain('coaching-cue')
    expect(chain).toHaveLength(1)
    expect(chain[0].catalogId).not.toBe('legacy:groq')
    expect(chain[0].providerId).not.toBe('groq')
  })

  it('deal-tier1 behaves identically — both live purposes, not just the one', () => {
    rejectTimes('groq', DEMOTION_THRESHOLD)
    const chain = resolveConfiguredChain('deal-tier1')
    expect(chain).toHaveLength(1)
    expect(chain[0].providerId).not.toBe('groq')
  })

  it('with no substitute available it keeps the legacy step rather than returning nothing', () => {
    // The failure this forbids: an empty chain reports "no AI configured" to a
    // user who has a key, mid-call. A demoted provider is better than none.
    for (const k of ['GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY']) {
      delete process.env[k]
    }
    rejectTimes('groq', DEMOTION_THRESHOLD)
    const chain = resolveConfiguredChain('coaching-cue')
    expect(chain).toHaveLength(1)
    expect(chain[0].catalogId).toBe('legacy:groq')
  })
})
