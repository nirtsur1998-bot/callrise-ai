// BUG-058 — the rate-limit spiral.
//
// THE BUG, concretely: nothing remembered a 429. Every call re-walked the
// chain from position 1, so the model that rate-limited us two seconds ago
// was hit first again, every time — and each failed call then walked the rest
// of the chain, converting ONE provider's limit into hitting every other
// provider's limit too. On a 9-entry quality chain with retries that is ~25
// requests per failed operation across 6 providers. Two operations can
// exhaust a free-tier account set, which is exactly what a founder reported
// from a demo machine with 6-7 free keys.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError, type AIFailureClass } from '../types'

const activeProviderId = { current: 'groq' as string | null }
const built: string[] = []
const behavior = {
  throwCode: 'rate-limit' as 'rate-limit' | 'auth' | 'failed',
  retryAfterMs: undefined as number | undefined,
  failTimes: Infinity,
  // BUG-057 Phase 2 — undefined here is the realistic default: most call
  // sites don't classify (see AIProviderError's own doc comment), and
  // effectiveFailureClass() must fall back to 'transient' for those.
  failureClass: undefined as AIFailureClass | undefined
}

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string, defaultModelId?: string) => ({
    displayName: id,
    keyEnvName,
    defaultModelId,
    build: () => ({
      id,
      complete: async () => {
        built.push(id)
        if (built.length > behavior.failTimes) return { text: 'ok', model: 'm', usage: {} }
        throw new AIProviderError(behavior.throwCode, `${id} limited`, behavior.retryAfterMs, behavior.failureClass)
      }
    })
  })
  return {
    PROVIDER_REGISTRY: {
      anthropic: make('anthropic', 'ANTHROPIC_API_KEY'),
      openai: make('openai', 'OPENAI_API_KEY'),
      groq: make('groq', 'GROQ_API_KEY', 'llama-3.3-70b-versatile'),
      openrouter: make('openrouter', 'OPENROUTER_API_KEY', 'openrouter/free'),
      google: make('google', 'GOOGLE_AI_API_KEY', 'gemini-flash-latest'),
      nvidia: make('nvidia', 'NVIDIA_API_KEY', 'deepseek-ai/deepseek-v3.2'),
      cerebras: make('cerebras', 'CEREBRAS_API_KEY', 'openai/gpt-oss-120b'),
      mistral: make('mistral', 'MISTRAL_API_KEY', 'mistral-small-latest')
    }
  }
})

const { loadAppSettings } = await import('../../app-settings')
const { completeWithFallback, AllModelsExhaustedError } = await import('../complete-with-fallback')
const {
  resetCooldownsForTests,
  markRateLimited,
  markPeriodExhausted,
  markStructurallyBroken,
  structuralBreakReason,
  isStructurallyBroken,
  isUsableFor,
  isCoolingDown,
  cooldownUntil,
  clearCooldown,
  soonestExpiry,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  STRUCTURAL_BREAK_MS
} = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')
// BUG-148 — provider demotion is module-global like cooldowns and pacing, so it
// leaks between tests the same way: a file that drives two auth failures leaves
// the provider DEMOTED for every later test in it. Measured with a probe, not
// assumed — asserting the demotion passed before this line existed.
//
// CORRECTION, and it is the more useful half. The first version of this comment
// said those later tests "silently exercise a REORDERED chain". They do not,
// and that claim was inferred from the demotion rather than measured. These
// fixtures mock `catalogEntry: () => null`, so `bundledSteps` always returns
// [] and the reorder — guarded on `tail.length > 0` — cannot fire. Demotion
// leaks; its EFFECT here is currently nil. The reset stays because the leak is
// real and the next fixture with a populated catalog would silently inherit it,
// which is exactly the class of thing nobody re-derives later.
const { resetDemotionsForTests } = await import('../provider-demotion')

// These pre-Phase-5 tests aren't about tiering — 'durable' on both the
// write (causedBy) and read (callerTier) side reproduces the exact
// pre-tiering "nothing ever bypasses" behavior, since a 'durable' caller
// never bypasses a 'durable'-caused entry.
const DURABLE = 'durable'

const PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]
const allEmpty = () =>
  ({ aiModelAssignments: Object.fromEntries(PURPOSES.map((p) => [p, { chain: [] }])) }) as unknown as ReturnType<typeof loadAppSettings>

// BUG-057 Phase 5 headline scenario — an EXPLICITLY CONFIGURED single-entry
// chain, identical for both purposes, so "a configured chain wins" (this
// file's own resolution-order comment) skips the implicit-tail logic
// entirely. Without this, memory-extract's naturally longer implicit
// fallback chain (it reaches google/openrouter/etc. that coaching-cue never
// does) makes `built` non-empty regardless of whether tiering bypass ever
// fires — a red-check that can't discriminate its own claim, caught by
// actually reading what `built` contained on a real revert rather than
// trusting a passing assertion.
const sharedOverlapChain = () =>
  ({
    aiModelAssignments: Object.fromEntries(
      PURPOSES.map((p) => [
        p,
        { chain: p === 'coaching-cue' || p === 'memory-extract' ? ['groq-llama-3.3-70b-versatile'] : [] }
      ])
    )
  }) as unknown as ReturnType<typeof loadAppSettings>

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetCooldownsForTests()
  resetDemotionsForTests()
  resetPacingForTests()
  built.length = 0
  behavior.throwCode = 'rate-limit'
  behavior.retryAfterMs = undefined
  behavior.failTimes = Infinity
  behavior.failureClass = undefined
  activeProviderId.current = 'groq'
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
  process.env.GROQ_API_KEY = 'g'
  process.env.GOOGLE_AI_API_KEY = 'goo'
  process.env.OPENROUTER_API_KEY = 'or'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('the cooldown store', () => {
  it('honours the provider\'s own retry hint over the default', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + 5_000)
  })

  it('falls back to a default when the provider gave no hint', () => {
    const now = 1_000_000
    markRateLimited('m', undefined, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + DEFAULT_COOLDOWN_MS)
  })

  it('caps an absurd hint so one bad header cannot sideline a model all session', () => {
    const now = 1_000_000
    markRateLimited('m', 86_400_000, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + MAX_COOLDOWN_MS)
  })

  it('expires on its own, with no sweeper', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, DURABLE)
    expect(isCoolingDown('m', now + 4_999)).toBe(true)
    expect(isCoolingDown('m', now + 5_001)).toBe(false)
  })

  it('never shortens an existing cooldown — concurrent jobs must not undo each other', () => {
    const now = 1_000_000
    markRateLimited('m', 30_000, now, DURABLE)
    markRateLimited('m', 1_000, now, DURABLE) // a second job reports a shorter delay
    expect(cooldownUntil('m', now)).toBe(now + 30_000)
  })

  it('a success clears it — evidence beats estimate', () => {
    const now = 1_000_000
    markRateLimited('m', 60_000, now, DURABLE)
    clearCooldown('m', 'coaching-cue')
    expect(isCoolingDown('m', now)).toBe(false)
  })
})

// BUG-057 Phase 4 — a model that keeps getting rate-limited with no explicit
// hint gets progressively less of our attention, reusing the same
// exponential-backoff idiom completeWithSameModelRetry already uses.
// Deliberately NOT a strikes-counter that deprioritizes after N failures —
// see the design doc's own scope narrowing — this escalates the cooldown's
// DURATION, one existing primitive (Map<catalogId, until>), not a new one.
describe('escalating backoff — repeated no-hint misses (BUG-057 Phase 4)', () => {
  it('the no-hint guess doubles on each consecutive miss: 60s -> 120s -> 240s', () => {
    let now = 1_000_000
    markRateLimited('m', undefined, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + DEFAULT_COOLDOWN_MS) // 60s

    now += DEFAULT_COOLDOWN_MS + 1 // let the first cooldown actually expire
    markRateLimited('m', undefined, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + DEFAULT_COOLDOWN_MS * 2) // 120s

    now += DEFAULT_COOLDOWN_MS * 2 + 1
    markRateLimited('m', undefined, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + DEFAULT_COOLDOWN_MS * 4) // 240s
  })

  it('the escalating guess is capped at MAX_COOLDOWN_MS, same ceiling as an explicit hint', () => {
    let now = 1_000_000
    // Enough consecutive misses to blow well past the cap on an
    // unescalated guess (60s * 2^7 = 7680s, far over MAX_COOLDOWN_MS/10min).
    for (let i = 0; i < 8; i++) {
      markRateLimited('m', undefined, now, DURABLE)
      const until = cooldownUntil('m', now) as number
      now = until + 1
    }
    markRateLimited('m', undefined, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + MAX_COOLDOWN_MS)
  })

  it('an explicit Retry-After hint is honoured outright, never escalated — the provider\'s own instruction wins', () => {
    let now = 1_000_000
    // Build up a streak via no-hint misses first...
    markRateLimited('m', undefined, now, DURABLE)
    now += DEFAULT_COOLDOWN_MS + 1
    markRateLimited('m', undefined, now, DURABLE)
    now += DEFAULT_COOLDOWN_MS * 2 + 1
    // ...then a real hint arrives. It must be honoured exactly, not
    // multiplied by whatever streak count preceded it.
    markRateLimited('m', 5_000, now, DURABLE)
    expect(cooldownUntil('m', now)).toBe(now + 5_000)
  })

  it('clearCooldown resets the streak — a later no-hint miss starts back at the base default', () => {
    const now = 1_000_000
    markRateLimited('m', undefined, now, DURABLE)
    clearCooldown('m', 'coaching-cue')

    const later = now + 999_999
    markRateLimited('m', undefined, later, DURABLE)
    expect(cooldownUntil('m', later)).toBe(later + DEFAULT_COOLDOWN_MS) // back to 60s, not 120s
  })

  it('a DIFFERENT catalogId has its own independent streak', () => {
    let now = 1_000_000
    markRateLimited('a', undefined, now, DURABLE)
    now += DEFAULT_COOLDOWN_MS + 1
    markRateLimited('a', undefined, now, DURABLE) // 'a' is now on its second miss (120s)

    markRateLimited('b', undefined, now, DURABLE) // 'b's first ever miss
    expect(cooldownUntil('b', now)).toBe(now + DEFAULT_COOLDOWN_MS) // 60s, not 120s
  })
})

describe('escalating backoff, through the real chain walk', () => {
  it('a model that keeps missing with no hint waits longer each time it recovers and misses again', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T12:00:00Z'))
      behavior.throwCode = 'rate-limit'
      behavior.retryAfterMs = undefined // the walker's own default guess, escalated per streak

      // First miss: cools for the base default (60s).
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      built.length = 0
      vi.setSystemTime(new Date(Date.now() + DEFAULT_COOLDOWN_MS + 1_000)) // past the 60s cooldown
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      // It WAS retried (cooldown had genuinely expired) -- this is the
      // second consecutive miss, so the NEXT cooldown escalates to 120s.
      expect(built.length).toBeGreaterThan(0)

      built.length = 0
      vi.setSystemTime(new Date(Date.now() + DEFAULT_COOLDOWN_MS + 1_000)) // 60s later -- NOT past a 120s cooldown
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      // Still cooling: if this were still the un-escalated 60s default, the
      // model would have recovered by now and been retried.
      expect(built).toEqual([])
    } finally {
      vi.useFakeTimers().clearAllTimers()
      vi.useRealTimers()
    }
  })
})

describe('the spiral, through the real chain walk', () => {
  it('a rate-limited model is NOT retried on the very next call', async () => {
    // The heart of the bug: before this, call 2 hit the same 429 first.
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    const firstWalk = [...built]
    expect(firstWalk.length).toBeGreaterThan(0)

    built.length = 0
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

    // Second call spends nothing: every model it would have tried is cooling.
    expect(built).toEqual([])
  })

  it('refuses with a WAIT TIME instead of a generic failure when everything is cooling', async () => {
    behavior.retryAfterMs = 20_000
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

    built.length = 0
    const err = await completeWithFallback({ purpose: 'memory-extract', messages: [] } as never).catch((e) => e)

    expect(err).toBeInstanceOf(AIProviderError)
    expect(err.code).toBe('rate-limit')
    // A number the user can act on — "chain exhausted" told them nothing.
    // M27 D — CORRECTED, not relaxed. This asserted the raw-seconds format
    // ("try again in about 3578s"), which was deliberately changed: that
    // exact string reached a real user, and nobody converts 3578 seconds to
    // "an hour" in their head. The guarantee this test protects is unchanged
    // and still asserted — the refusal must carry an ACTIONABLE WAIT TIME
    // rather than a generic failure — only its rendering moved.
    expect(err.message).toMatch(/try again in (a moment|about \d+ (seconds|minutes?|hours?)|about an hour|about a day)/i)
    expect(built).toEqual([]) // and it cost zero requests
  })

  it('a model that recovers is used again once its cooldown expires', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T12:00:00Z'))
      behavior.retryAfterMs = 5_000
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

      built.length = 0
      vi.setSystemTime(new Date('2026-08-13T12:00:06Z')) // past the 5s hint
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

      expect(built.length).toBeGreaterThan(0)
    } finally {
      vi.useFakeTimers().clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('only rate limits cool down — a plain failure still retries next call', async () => {
    // A cooldown is a response to being ASKED to back off. Applying it to
    // every failure would sideline healthy models after one blip.
    behavior.throwCode = 'failed'
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    const first = built.length
    expect(first).toBeGreaterThan(0)

    built.length = 0
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    expect(built.length).toBe(first)
  })
})

// BUG-057 Phase 2 — per-class storage. A structural failure (auth rejected,
// model delisted, a 400 on this exact request shape) and a period-exhausted
// one (daily/monthly quota, credits gone) both need a SHAPE the plain
// cooldown map never had: "don't retry, but for a much longer/different
// reason than an ordinary rate limit."
describe('structural breaks — self-healing, not permanent (first-pass fatal #1, fixed)', () => {
  const PUR = 'coaching-cue' as const

  it('marks a model unusable immediately', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, PUR)
    expect(isStructurallyBroken('m', now, PUR)).toBe(true)
    expect(isUsableFor('m', now, DURABLE, { purpose: PUR })).toBe(false)
  })

  it('self-heals after STRUCTURAL_BREAK_MS — fails on the first pass\'s permanent-map shape', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, PUR)
    expect(isStructurallyBroken('m', now + STRUCTURAL_BREAK_MS - 1, PUR)).toBe(true)
    expect(isStructurallyBroken('m', now + STRUCTURAL_BREAK_MS + 1, PUR)).toBe(false)
  })

  it('a success clears it early — proof beats the guess', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, PUR)
    clearCooldown('m', 'coaching-cue')
    expect(isStructurallyBroken('m', now, PUR)).toBe(false)
  })

  // AUDIT FIX (2026-08-24) — THE containment property, and the reason the
  // map is keyed by purpose at all. A 400 is a statement about one request;
  // before this it disabled the model for every purpose in the app for four
  // hours. On a fresh install every purpose falls through to the SHARED
  // synthetic legacy step and LEGACY_TAIL_MAX['coaching-cue'] = 0 makes
  // coaching-cue's chain exactly one entry long — so one PDF attached in a
  // Rise chat killed live call coaching until the TTL expired, with nothing
  // naming the cause and no way to clear it.
  it('a break proven by one purpose does NOT disable the model for another', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, 'assistant-chat')

    expect(isStructurallyBroken('m', now, 'assistant-chat')).toBe(true)
    expect(
      isStructurallyBroken('m', now, 'coaching-cue'),
      'a 400 on a Rise chat request disabled live coaching cues — the exact ' +
        'cross-purpose damage this scoping exists to prevent'
    ).toBe(false)
    expect(isUsableFor('m', now, DURABLE, { purpose: 'coaching-cue' })).toBe(true)
    expect(isUsableFor('m', now, DURABLE, { purpose: 'assistant-chat' })).toBe(false)
  })

  // A success is proof about the purpose that produced it, and nothing more.
  it("a success on one purpose does not clear another purpose's break", () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, 'assistant-chat')
    clearCooldown('m', 'coaching-cue')
    expect(isStructurallyBroken('m', now, 'assistant-chat')).toBe(true)
    clearCooldown('m', 'assistant-chat')
    expect(isStructurallyBroken('m', now, 'assistant-chat')).toBe(false)
  })

  // BUG-125d — a break benches a model for up to 4h and nothing recorded WHY.
  // The founder's keyed Claude was benched on an image turn and the product
  // could only say "blocked by the usability gate": true, useless, and one
  // question short of the answer. The cause is known at the moment the break
  // is set and was simply discarded.
  it('records WHY the break was set, so a benched model can explain itself', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, 'assistant-chat', 'failed: 400 image exceeds 5 MB')
    expect(structuralBreakReason('m', 'assistant-chat')).toBe('failed: 400 image exceeds 5 MB')
  })

  it('the reason is scoped to the purpose, like the break itself', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, 'assistant-chat', 'failed: 400 bad image')
    expect(structuralBreakReason('m', 'coaching-cue')).toBeNull()
  })

  it('clearing the break clears its reason — no stale cause outliving the block', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, 'assistant-chat', 'failed: 400 bad image')
    clearCooldown('m', 'assistant-chat')
    expect(structuralBreakReason('m', 'assistant-chat')).toBeNull()
  })

  it('with no purpose in question a structural break does not apply', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, 'assistant-chat')
    expect(isStructurallyBroken('m', now, null)).toBe(false)
    expect(isUsableFor('m', now, DURABLE)).toBe(true)
  })

  it('does not shorten an existing break — the same never-shorten rule as an ordinary cooldown', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now, PUR)
    markStructurallyBroken('m', now + 1000, PUR) // a later mark, shorter remaining TTL from its own perspective
    expect(isStructurallyBroken('m', now + STRUCTURAL_BREAK_MS - 1, PUR)).toBe(true)
  })
})

describe('period-exhausted — a much longer wait than an ordinary rate limit', () => {
  it('defaults to PERIOD_EXHAUSTED_DEFAULT_MS when the provider gave no hint, far past MAX_COOLDOWN_MS', () => {
    const now = 1_000_000
    markPeriodExhausted('m', undefined, now, DURABLE)
    const until = cooldownUntil('m', now)
    expect(until).not.toBeNull()
    expect((until as number) - now).toBeGreaterThan(MAX_COOLDOWN_MS)
  })

  it('honours a provider retryAfterMs hint, capped at PERIOD_EXHAUSTED_MAX_MS (24h)', () => {
    const now = 1_000_000
    markPeriodExhausted('m', 999 * 60 * 60_000, now, DURABLE) // an absurd 999h hint
    const until = cooldownUntil('m', now)
    expect((until as number) - now).toBe(24 * 60 * 60_000)
  })

  it('shares the ordinary cooldown map — isCoolingDown/isUsable both see it', () => {
    const now = 1_000_000
    markPeriodExhausted('m', 5_000, now, DURABLE)
    expect(isCoolingDown('m', now)).toBe(true)
    expect(isUsableFor('m', now, DURABLE, { purpose: 'coaching-cue' })).toBe(false)
  })

  describe('BUG-058 Phase 3 — resetsAt replaces the 1h guess, but never beats an explicit retryAfterMs', () => {
    it('uses resetsAt instead of PERIOD_EXHAUSTED_DEFAULT_MS when no retryAfterMs hint exists', () => {
      const now = 1_000_000
      const resetsAt = now + 3 * 60 * 60_000 // 3h out — real data, not the 1h guess
      markPeriodExhausted('m', undefined, now, DURABLE, resetsAt)
      const until = cooldownUntil('m', now)
      expect(until).toBe(resetsAt)
    })

    it('an explicit retryAfterMs still wins outright over resetsAt — a direct instruction beats an estimate', () => {
      const now = 1_000_000
      const resetsAt = now + 3 * 60 * 60_000 // 3h out — must NOT be what wins
      // Above the 60s floor both paths share, so a value winning here can only
      // mean retryAfterMs itself was used, not a floor coincidence.
      markPeriodExhausted('m', 90_000, now, DURABLE, resetsAt)
      const until = cooldownUntil('m', now)
      expect((until as number) - now).toBe(90_000)
    })

    it('resetsAt is still capped at PERIOD_EXHAUSTED_MAX_MS, same backstop as the guess', () => {
      const now = 1_000_000
      const resetsAt = now + 999 * 60 * 60_000 // an absurd 999h-out value
      markPeriodExhausted('m', undefined, now, DURABLE, resetsAt)
      const until = cooldownUntil('m', now)
      expect((until as number) - now).toBe(24 * 60 * 60_000)
    })

    it('omitting resetsAt falls back to the ordinary 1h guess, unchanged behavior', () => {
      const now = 1_000_000
      markPeriodExhausted('m', undefined, now, DURABLE)
      const until = cooldownUntil('m', now)
      expect((until as number) - now).toBeGreaterThan(MAX_COOLDOWN_MS)
      expect((until as number) - now).toBeLessThan(24 * 60 * 60_000)
    })
  })
})

describe('the taxonomy, through the real chain walk', () => {
  it('a period-exhausted rate-limit cools for far longer than an ordinary one — proves markPeriodExhausted fired, not markRateLimited', async () => {
    // Can't read cooldownUntil(catalogId, ...) directly here — `built`
    // records the mock registry's PROVIDER id, not the resolved catalogId
    // model-cooldown.ts actually keys on, and this test doesn't have that
    // mapping. Proven behaviorally instead, with fake time: no retryAfterMs
    // hint means the two code paths' DEFAULTS differ by over an order of
    // magnitude (60s vs 1h) — advancing PAST the ordinary default but well
    // BEFORE the period-exhausted one discriminates which one actually fired.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T12:00:00Z'))
      behavior.throwCode = 'rate-limit'
      behavior.failureClass = 'period-exhausted'
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

      built.length = 0
      vi.setSystemTime(new Date('2026-08-13T12:01:05Z')) // +65s: past DEFAULT_COOLDOWN_MS (60s)
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      // If markRateLimited (the ordinary 60s default) had fired instead, the
      // model would already be usable again here — it must still be empty.
      expect(built).toEqual([])

      built.length = 0
      vi.setSystemTime(new Date('2026-08-13T13:01:05Z')) // +1h1m5s: past PERIOD_EXHAUSTED_DEFAULT_MS (1h)
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      expect(built.length).toBeGreaterThan(0)
    } finally {
      vi.useFakeTimers().clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('a structural failure excludes the model from every future call until it self-heals', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T12:00:00Z'))
      behavior.throwCode = 'failed'
      behavior.failureClass = 'structural'

      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      const brokenId = built[0]
      expect(brokenId).toBeTruthy()

      built.length = 0
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      // Excluded before any attempt — same "refuse before spending a
      // request" shape as an ordinary cooldown.
      expect(built).toEqual([])

      built.length = 0
      vi.setSystemTime(new Date(Date.now() + STRUCTURAL_BREAK_MS + 1000))
      behavior.throwCode = 'rate-limit' // let it succeed-shaped-enough to prove it was RE-ATTEMPTED, not that it succeeds
      behavior.failTimes = 0 // succeed on first attempt this round
      await completeWithFallback({ purpose: 'memory-extract', messages: [] } as never).catch(() => {})
      expect(built).toContain(brokenId)
    } finally {
      vi.useFakeTimers().clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('a "failed"-coded quota exhaustion cools down exactly like a rate-limited one — M27 B3', async () => {
    // Reproduces openai-compatible.ts's real "out of quota/credits" branch:
    // toProviderError() hardcodes failureClass:'period-exhausted' there, but
    // the raw code is 'failed', not 'rate-limit' — this provider never sends
    // a 429 for it, only a plain error whose MESSAGE says quota. Before this
    // fix, the gating condition required BOTH reason==='rate-limit' AND
    // failureClass==='period-exhausted', so this exact real combination fell
    // through every branch and got zero cooldown — confirmed against this
    // app's own real fallback log, 14% of all logged events were this shape.
    behavior.throwCode = 'failed'
    behavior.failureClass = 'period-exhausted'

    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    const exhaustedId = built[0]
    expect(exhaustedId).toBeTruthy()

    built.length = 0
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    // Refused before any attempt — same "refuse before spending a request"
    // shape as the structural-failure test above. Before this fix, the model
    // would appear in `built` again here, identical to a plain 'failed' with
    // no quota signal (the "only rate limits cool down" test earlier in this
    // file) — that's the exact bug this test catches.
    expect(built).toEqual([])
  })

  it('an auth failure does NOT also get marked structurally broken — deadProviders already excludes it, avoiding two independent encodings drifting apart', async () => {
    behavior.throwCode = 'auth'
    // Left set to 'structural' deliberately: real auth branches across all 4
    // providers set failureClass:'structural' too, but the catch block's
    // own `reason !== 'auth'` guard must be what actually prevents the
    // double-mark, not an accident of this test's fixture leaving
    // failureClass unset. Set it explicitly to prove the guard, not the gap.
    behavior.failureClass = 'structural'
    const caught = await completeWithFallback({ purpose: 'memory-extract', messages: [] } as never).catch(
      (err: unknown) => err
    )
    expect(caught).toBeInstanceOf(AllModelsExhaustedError)
    const attempts = (caught as InstanceType<typeof AllModelsExhaustedError>).attempts
    expect(attempts.length).toBeGreaterThan(0) // sanity: the walk actually reached and recorded attempts

    // FIXED FOLLOW-UP (was tracked in the M26 vault doc's taxonomy section):
    // this used to check `isStructurallyBroken(built[0], ...)`, where
    // `built[0]` is the mock provider's bare id (e.g. 'groq') pushed by the
    // registry fixture below — NOT the catalogId `markStructurallyBroken`
    // actually keys on (e.g. 'groq-llama-3.3-70b-versatile', see
    // DEFAULT_CATALOG_CHAIN's SPEED_CHAIN in complete-with-fallback.ts).
    // Those are different strings, so the old assertion checked a key that
    // could never be marked either way — vacuously true regardless of
    // whether the `reason !== 'auth'` guard existed, worked, or was
    // removed. Confirmed empirically, not just reasoned about: narrowing
    // the guard from `failureClass === 'structural' && reason !== 'auth'`
    // to `failureClass === 'structural'` alone left the old assertion
    // passing, while THIS version (checking every real attempt.catalogId
    // from the thrown error) correctly fails under that exact narrowed
    // condition — verified by making that one-line change locally and
    // watching this assertion flip red, then reverting it.
    for (const attempt of attempts) {
      expect(isStructurallyBroken(attempt.catalogId, Date.now(), 'coaching-cue')).toBe(false)
    }
  })

  it('an ambiguous failure (failureClass unset) defaults to transient, not structural — the first-pass fatal #2 fix', async () => {
    behavior.throwCode = 'failed'
    behavior.failureClass = undefined // the realistic "nothing classified it" case
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    const id = built[0]

    built.length = 0
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    // NOT excluded — a 'structural' default here would have blocked this
    // exact call, which is precisely the first-pass bug this fixes.
    expect(built).toContain(id)
  })
})

// BUG-057 Phase 5 — tiered cooldown. coaching-cue polls every ~2.5s and can
// cool down the 1-2 models it reaches; a much-slower durable purpose
// (memory-extract, summary, ...) sharing one of those models used to be
// starved by cooldowns it never caused. A 'durable' caller may now bypass a
// cooldown a 'live' caller caused — but never one another 'durable' caller
// caused, and never a structural break regardless of tier.
describe('tiered cooldown — durable bypasses live, never durable, never structural (BUG-057 Phase 5)', () => {
  it('a live-caused cooldown IS bypassable by a durable caller', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, 'live')
    expect(isUsableFor('m', now, 'durable')).toBe(true)
  })

  it('a live-caused cooldown is NOT bypassable by another live caller — that would defeat BUG-058 entirely', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, 'live')
    expect(isUsableFor('m', now, 'live')).toBe(false)
  })

  it('a durable-caused cooldown is NOT bypassable by a durable caller — durable purposes fire rare enough that their own failure is stronger evidence', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, 'durable')
    expect(isUsableFor('m', now, 'durable')).toBe(false)
  })

  it('a durable-caused cooldown is NOT bypassable by a live caller either', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, 'durable')
    expect(isUsableFor('m', now, 'live')).toBe(false)
  })

  it('durable causation is sticky: a later live re-mark does not downgrade it to bypassable', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, 'durable')
    markRateLimited('m', 5_000, now + 1, 'live') // a live purpose also hits the same model
    expect(isUsableFor('m', now + 1, 'durable')).toBe(false) // still not bypassable
  })

  it('a live re-mark of a live-caused cooldown stays bypassable by durable', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now, 'live')
    markRateLimited('m', 5_000, now + 1, 'live')
    expect(isUsableFor('m', now + 1, 'durable')).toBe(true)
  })

  it('a structural break is never bypassable, regardless of tier — the critique\'s bug 2, fixed', () => {
    // Mark a catalogId BOTH live-cooling AND independently structurally
    // broken. The first-pass sketch skipped the structural check entirely
    // on the bypass path, so a durable caller would have been let through
    // into a request the system already knows will fail deterministically.
    const now = 1_000_000
    markRateLimited('m', 5_000, now, 'live')
    markStructurallyBroken('m', now, 'coaching-cue')
    expect(isUsableFor('m', now, 'durable', { purpose: 'coaching-cue' })).toBe(false)
  })

  it('period-exhausted cooldowns follow the same tiering as ordinary rate limits', () => {
    const now = 1_000_000
    markPeriodExhausted('m', 5_000, now, 'live')
    expect(isUsableFor('m', now, 'durable')).toBe(true)
    expect(isUsableFor('m', now, 'live')).toBe(false)
  })

  it('soonestExpiry only counts cooldowns THIS caller tier cannot bypass', () => {
    const now = 1_000_000
    markRateLimited('live-caused', 5_000, now, 'live')
    markRateLimited('durable-caused', 60_000, now, 'durable')
    // A durable caller can bypass 'live-caused' — only 'durable-caused'
    // should count toward its reported wait.
    expect(soonestExpiry(['live-caused', 'durable-caused'], now, 'durable')).toBe(now + 60_000)
    // A live caller can bypass neither.
    expect(soonestExpiry(['live-caused', 'durable-caused'], now, 'live')).toBe(now + 5_000)
  })

  it('an expired entry is usable for anyone and is cleaned up on read', () => {
    const now = 1_000_000
    markRateLimited('m', 1_000, now, 'live')
    expect(isUsableFor('m', now + 1_001, 'live')).toBe(true)
    expect(isCoolingDown('m', now + 1_001)).toBe(false)
  })
})

describe('tiered cooldown, through the real chain walk — the headline scenario', () => {
  it('memory-extract is NOT starved by a cooldown coaching-cue caused on the shared model', async () => {
    // Explicitly configured, IDENTICAL single-entry chain for both purposes
    // — no implicit tail, no ambiguity about which entry either purpose can
    // reach. Without this, memory-extract's naturally longer implicit
    // fallback chain (it also reaches google/openrouter/etc., which
    // coaching-cue's 0-length CHAIN_BUDGET tail never does) makes `built`
    // non-empty regardless of whether bypass ever fires — confirmed by
    // directly inspecting `built` on an earlier draft of this test, which
    // read `["google","openrouter","openrouter"]` on a full Phase 5 revert:
    // passing for the wrong reason, not proving the claim at all.
    vi.mocked(loadAppSettings).mockReturnValue(sharedOverlapChain())
    behavior.throwCode = 'rate-limit'
    behavior.retryAfterMs = undefined

    // coaching-cue (a 'live' purpose, in CHAIN_BUDGET) hits the rate limit
    // first and cools the shared model.
    await expect(completeWithFallback({ purpose: 'coaching-cue', messages: [] } as never)).rejects.toBeTruthy()
    built.length = 0

    // memory-extract (a 'durable' purpose) fires next, on the SAME single
    // configured entry, WHILE it's still cooling. Before Phase 5 this would
    // spend zero requests, same as any other cooling model — the exact
    // starvation bug.
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    // CORRECTED, NOT RELAXED (2026-08-30, BUG-142) — and the FIRST attempt at
    // this correction WAS a relaxation, caught by red-checking it.
    //
    // The claim is the BYPASS: a durable purpose spends a request on a model a
    // LIVE purpose cooled, instead of being starved. The old form asserted the
    // whole list (`['groq']`), which also forbade anything else ever being
    // tried — never this test's subject, and BUG-142's end-of-walk rescue now
    // appends one other keyed provider once the bypassed attempt fails.
    //
    // The relaxation, recorded because it is the instructive part: the first
    // correction asserted `expect(built).toContain('groq')`. That still PASSED
    // with the bypass deliberately broken, because groq is reached anyway —
    // last, via the rescue — giving `['openrouter', 'google', 'groq']`. "groq
    // was attempted" is true in both worlds, so it discriminated nothing. What
    // separates a bypass from a rescue is not WHETHER the cooled model is
    // tried but WHEN: the bypass tries it FIRST, as the configured entry.
    // Hence `built[0]`, verified red on the broken bypass and green on the
    // restored one.
    expect(built[0]).toBe('groq') // bypassed — the ONE shared entry was attempted FIRST
    expect(built.filter((b) => b === 'groq')).toHaveLength(1)
  })

  it('coaching-cue does NOT bypass its own cooldown on the shared model — that would defeat BUG-058', async () => {
    // HONEST LIMITATION: this doesn't discriminate on its own — under the
    // pre-Phase-5 code nothing ever bypasses anything either, so `built`
    // would ALSO be empty on a full revert. It's a real boundary/regression
    // test (bypass must not over-extend to same-tier callers), just not a
    // red-check-provable one in isolation; the positive case above
    // ("IS bypassable by a durable caller") is what actually proves the
    // bypass mechanism exists at all.
    vi.mocked(loadAppSettings).mockReturnValue(sharedOverlapChain())
    behavior.throwCode = 'rate-limit'
    behavior.retryAfterMs = undefined

    await expect(completeWithFallback({ purpose: 'coaching-cue', messages: [] } as never)).rejects.toBeTruthy()
    built.length = 0

    // Another live-tier call (coaching-cue again) must NOT bypass — only a
    // durable caller may.
    await expect(completeWithFallback({ purpose: 'coaching-cue', messages: [] } as never)).rejects.toBeTruthy()
    expect(built).toEqual([])
  })

  it('a genuine account-wide limit (durable purpose fails first) still blocks coaching-cue too', async () => {
    // Same HONEST LIMITATION as the test above — a boundary case that's
    // trivially true pre-Phase-5 too (nothing bypasses anything), so it
    // doesn't discriminate this claim on its own either.
    vi.mocked(loadAppSettings).mockReturnValue(sharedOverlapChain())
    behavior.throwCode = 'rate-limit'
    behavior.retryAfterMs = undefined

    // memory-extract (durable) fails first — stronger evidence of a real,
    // account-wide limit, per the sticky-durable-causation rule.
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    built.length = 0

    // coaching-cue must NOT get a special pass just for being live-tier —
    // a durable-caused cooldown is bypassable by nobody.
    await expect(completeWithFallback({ purpose: 'coaching-cue', messages: [] } as never)).rejects.toBeTruthy()
    expect(built).toEqual([])
  })
})
