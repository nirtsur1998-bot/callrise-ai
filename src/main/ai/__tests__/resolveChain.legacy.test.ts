// BUG-057 — the legacy single-provider branch of resolveChain.
//
// A NEW FILE rather than additions to resolveChain.test.ts, because that file
// mocks `getActiveAIProvider: () => null` at module scope, which mocks this
// entire branch out of existence. Before this file, `if (legacy) return
// [legacy]` — the line that made a chosen default provider silently mean "and
// no fallback, ever, for every purpose Settings cannot reach" — was executed
// by exactly zero tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIPurpose } from '../types'

const activeProviderId = { current: 'groq' as string | null }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () =>
    activeProviderId.current ? { id: activeProviderId.current } : null
}))

const { loadAppSettings } = await import('../../app-settings')
const { resolveConfiguredChain } = await import('../complete-with-fallback')
const { PROVIDER_REGISTRY } = await import('../registry')
const { MODEL_CATALOG } = await import('../model-catalog')
const { markPeriodExhausted, markStructurallyBroken, markRateLimited, resetCooldownsForTests } =
  await import('../model-cooldown')

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

/** Every purpose unconfigured — which is the whole point: an empty chain is
 *  what routes a purpose into the legacy branch, and it is the DEFAULT for
 *  all twelve on a fresh install. */
function allEmpty(overrides: Partial<Record<AIPurpose, string[]>> = {}) {
  const aiModelAssignments = Object.fromEntries(
    ALL_PURPOSES.map((p) => [p, { chain: overrides[p] ?? [] }])
  )
  return { aiModelAssignments } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
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

describe('resolveChain — a default provider no longer means "no fallback"', () => {
  it('appends a fallback tail behind the legacy step', () => {
    const steps = resolveConfiguredChain('memory-extract')
    // The bug: this was exactly 1.
    expect(steps.length).toBeGreaterThan(1)
  })

  it('the legacy step is still FIRST — an existing install\'s first attempt is unchanged', () => {
    const steps = resolveConfiguredChain('memory-extract')
    expect(steps[0].catalogId).toBe('legacy:groq')
    expect(steps[0].modelId).toBe('') // '' => provider uses its own default, exactly as before
    expect(steps[0].fromImplicitTail).toBeFalsy()
  })

  it('the first fallback is a DIFFERENT provider — the one most likely to actually work', () => {
    const steps = resolveConfiguredChain('memory-extract')
    expect(steps[1].providerId).not.toBe('groq')
  })

  it('never re-issues the legacy step\'s own model as a later attempt', () => {
    // groq's defaultModel is byte-identical to one of its catalog entries'
    // modelId. Without the guard, a single-key user's attempt 1 and a later
    // "fallback" are literally the same request.
    //
    // CORRECTED, NOT RELAXED (2026-08-30, BUG-081). This pinned the literal
    // 'llama-3.3-70b-versatile', which is a stricter claim than the premise the
    // line itself says it is pinning: the premise is that the legacy default
    // COLLIDES with some catalog entry for that provider, not that it is one
    // particular string. BUG-081 changed Groq's default to openai/gpt-oss-120b
    // (the old id was being rejected on the founder's account); the premise held
    // exactly as before and the test failed anyway.
    //
    // Asserting the collision keeps the real guarantee — a default that stopped
    // colliding would make this whole test VACUOUS, and that still goes red —
    // while a legitimate model change no longer reads as a regression.
    const legacyModel = PROVIDER_REGISTRY.groq.defaultModelId
    expect(
      MODEL_CATALOG.some((e) => e.providerId === 'groq' && e.modelId === legacyModel),
      `groq's legacy default '${legacyModel}' no longer matches any groq catalog entry — ` +
        'the collision this test guards against is gone, so the test below proves nothing'
    ).toBe(true)
    const steps = resolveConfiguredChain('memory-extract')
    expect(steps.slice(1).map((s) => s.modelId)).not.toContain(legacyModel)
  })

  it('a single-key user gets AT MOST ONE same-provider retry, and it is not a duplicate', () => {
    // The user requirement: "for a single-key user, 'fall back to the bundled
    // chain' is just slower failure." One extra attempt on a DIFFERENT model
    // of the same key is justified (Groq/Gemini rate-limit per-model); a
    // parade of them is not.
    //
    // BUG-154 (2026-09-01) — REPOINTED FROM GROQ TO NVIDIA, and the reason is
    // the finding itself rather than test convenience. Two Groq ids were
    // confirmed dead and are now knownStale, which leaves Groq with exactly
    // ONE live catalog entry whose modelId IS its legacy default. So for Groq
    // there is no longer any "different model on the same key" to retry, and
    // this test's premise is genuinely false for that provider — the tail is
    // correctly empty. That is not a regression: the two entries it lost were
    // guaranteed failures. NVIDIA is the fixture now because it actually has
    // two live models in this chain.
    //
    // The premise is ASSERTED rather than assumed, matching the guard the
    // sibling test above already carries: if NVIDIA ever drops to one live
    // entry, this goes red naming that fact, instead of silently proving
    // nothing the way a bare `tail.length` check would.
    activeProviderId.current = 'nvidia'
    delete process.env.GROQ_API_KEY
    delete process.env.GOOGLE_AI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    process.env.NVIDIA_API_KEY = 'nv'

    const liveNvidia = MODEL_CATALOG.filter((e) => e.providerId === 'nvidia' && !e.knownStale)
    expect(
      liveNvidia.length,
      'nvidia no longer has two live catalog entries, so "one same-provider retry" ' +
        'cannot be distinguished from "no retry available" and this test proves nothing'
    ).toBeGreaterThanOrEqual(2)

    const steps = resolveConfiguredChain('memory-extract')
    const tail = steps.slice(1)

    expect(tail.length).toBe(1)
    expect(tail[0].providerId).toBe('nvidia')
    expect(tail[0].modelId).not.toBe(PROVIDER_REGISTRY.nvidia.defaultModelId)
  })

  it('only providers with a key configured are ever in the tail', () => {
    delete process.env.GOOGLE_AI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    const steps = resolveConfiguredChain('memory-extract')
    expect(steps.every((s) => s.providerId === 'groq')).toBe(true)
  })

  it('never puts a knownStale model in the tail', () => {
    const ids = resolveConfiguredChain('memory-extract').map((s) => s.catalogId)
    expect(ids).not.toContain('groq-llama-4-scout')
    expect(ids).not.toContain('groq-qwen3-32b')
  })

  it('tail entries are flagged fromImplicitTail — models the user never chose', () => {
    const steps = resolveConfiguredChain('memory-extract')
    // Assert the tail EXISTS before asserting things about it: `[].every()`
    // is vacuously true, so without this line the test passed even with the
    // whole fix reverted, proving nothing.
    expect(steps.length).toBeGreaterThan(1)
    expect(steps.slice(1).every((s) => s.fromImplicitTail === true)).toBe(true)
  })
})

describe('resolveChain — the caps', () => {
  it('background purposes get at most 3 extra attempts (4 total)', () => {
    for (const p of [
      'summary',
      'scorecard',
      'memory-extract',
      'deal-tier2',
      'assistant-chat'
    ] as AIPurpose[]) {
      expect(resolveConfiguredChain(p).length).toBeLessThanOrEqual(4)
    }
  })

  it('interactive purposes where a human is waiting get exactly one extra', () => {
    for (const p of ['other', 'coaching-chat'] as AIPurpose[]) {
      expect(resolveConfiguredChain(p).length).toBeLessThanOrEqual(2)
    }
  })

  // M28, 2026-08-21 — regression for a real field failure, not a guess: the
  // founder's own ai-fallback-events.jsonl showed assistant-chat's ENTIRE
  // chain die on exactly two links (legacy:groq's dead default model, then
  // a genuinely daily-quota-exhausted Gemini) while summary/scorecard kept
  // working on the same account, because THEY had 3 bundled fallbacks
  // behind the same broken legacy step and assistant-chat — copying
  // coaching-chat's tail=1 "human is watching" reasoning without checking
  // whether it fit a purpose that fires 2-3x per single user message on the
  // same thin chain — had only 1. Regression test for that reversal:
  // assistant-chat must have room for the same depth the other quality-lane
  // purposes already rely on, not the tight interactive cap.
  it('assistant-chat gets the resilient quality-lane tail, not the tight interactive one', () => {
    const chain = resolveConfiguredChain('assistant-chat')
    expect(chain[0].catalogId).toBe('legacy:groq') // unchanged: first attempt is still today's default
    expect(chain.length).toBeGreaterThan(2) // the actual regression: used to cap at 2
    expect(chain.length).toBeLessThanOrEqual(4)
  })

  it('LIVE purposes get the SECOND attempt their budget already paid for', () => {
    // WAS "still exactly one attempt, no tail". BUG-159 (founder, 2026-09-01)
    // reversed that: "I want all keys to work and if one fails for the system
    // to direct the work to it and won't deny a job from the user."
    //
    // The original reasoning — keeping chain.length at 1 makes the per-attempt
    // budget split "bit-identical to today", provably zero-risk for M9's
    // dead-air fix and M24's <=4s criterion — is still exactly how the budget
    // works, and is precisely why TWO attempts are safe: completeWithFallback
    // divides remainingBudgetMs by the remaining entries, so they SHARE the six
    // seconds rather than doubling them. CHAIN_BUDGET had declared
    // maxChainLength 2 all along; only LEGACY_TAIL_MAX disagreed.
    //
    // The FIRST attempt is still the user's pinned default, so an existing
    // install's first request is byte-identical to before.
    expect(resolveConfiguredChain('coaching-cue')).toHaveLength(2)
    expect(resolveConfiguredChain('deal-tier1')).toHaveLength(2)
    expect(resolveConfiguredChain('coaching-cue')[0].catalogId).toBe('legacy:groq')
    // The second attempt is a DIFFERENT provider — retrying the same one would
    // not survive the account-level failures this exists to route around.
    const chain = resolveConfiguredChain('coaching-cue')
    expect(chain[1].providerId).not.toBe(chain[0].providerId)
  })
})

describe('resolveChain — what must NOT change', () => {
  it('a CONFIGURED chain resolves exactly as before, with no tail appended', () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      allEmpty({ summary: ['groq-gpt-oss-120b', 'google-gemini-flash'] })
    )
    const steps = resolveConfiguredChain('summary')
    expect(steps.map((s) => s.catalogId)).toEqual(['groq-gpt-oss-120b', 'google-gemini-flash'])
    // The user authored this ordering — falling back within it is the system
    // doing what they asked, not an implicit substitution.
    expect(steps.every((s) => !s.fromImplicitTail)).toBe(true)
  })

  it('with no legacy provider at all, the bundled-only branch is unchanged', () => {
    activeProviderId.current = null
    const steps = resolveConfiguredChain('summary')
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((s) => !s.fromImplicitTail)).toBe(true)
    expect(steps.every((s) => s.catalogId.startsWith('legacy:') === false)).toBe(true)
  })
})

describe('memory-extract is no longer single-lane', () => {
  it('spans more than one provider, so a rate-limited account is escapable', () => {
    // Without widening past SPEED_CHAIN (groq+cerebras only), the entire
    // "fallback" for this purpose was more requests to the same 429 — the fix
    // would pass a unit test and still fail live on the founder's machine.
    const steps = resolveConfiguredChain('memory-extract')
    const providers = new Set(steps.map((s) => s.providerId))
    expect(providers.size).toBeGreaterThanOrEqual(2)
  })
})


// BUG-154 follow-up (2026-09-01) — the live purposes must not starve when the
// pinned default cannot answer.
//
// FOUND BY DRIVING A REAL CALL, twice, not by reading the code. The founder
// reported dead live cues on a machine with twelve keys. The first fix made
// the catalog reachable; cues stayed dead, because coaching-cue has
// LEGACY_TAIL_MAX 0 and its only escape was BUG-148's demotion, which is
// AUTH-ONLY. The second fix added structural breaks; cues stayed dead, because
// the pinned provider had hit QUOTA, which is period-exhaustion — so nothing
// substituted, the walk skipped its single step, and it attempted nothing at
// all. Silent failure, not fixed failure.
//
// Each test below marks a DIFFERENT unavailability and asserts the same two
// things: a substitute is chosen, and the chain is STILL EXACTLY ONE STEP
// (the founder's latency constraint from BUG-148 decision 5B is untouched --
// only which single attempt it buys changes).
describe('BUG-154 — a live purpose substitutes when its pinned default cannot answer', () => {
  const LIVE: AIPurpose[] = ['coaching-cue', 'deal-tier1']

  beforeEach(() => {
    resetCooldownsForTests()
    activeProviderId.current = 'groq'
    vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
    process.env.GROQ_API_KEY = 'g'
    process.env.CEREBRAS_API_KEY = 'c'
  })

  it.each(LIVE)('%s: control — an untouched default is used FIRST', (purpose) => {
    // Without this the tests below cannot tell "substituted" from "never used
    // the legacy step in the first place". Length is 2 since BUG-159 gave the
    // live purposes the second attempt their budget already allowed; what this
    // control asserts is that a healthy default still LEADS.
    const chain = resolveConfiguredChain(purpose)
    expect(chain).toHaveLength(2)
    expect(chain[0].catalogId).toBe('legacy:groq')
  })

  it.each(LIVE)('%s: substitutes when the default is PERIOD-EXHAUSTED (the real case)', (purpose) => {
    markPeriodExhausted('legacy:groq', undefined, Date.now(), 'live')
    const chain = resolveConfiguredChain(purpose)
    // Two steps since BUG-159. What matters is that the unusable default no
    // longer LEADS: it is demoted behind a step that can actually answer, and
    // deliberately still present so it can earn its place back with a success.
    expect(chain).toHaveLength(2)
    expect(chain[0].providerId).not.toBe('groq')
    expect(chain.map((s) => s.catalogId)).toContain('legacy:groq')
  })

  it.each(LIVE)('%s: substitutes when the default is STRUCTURALLY BROKEN', (purpose) => {
    markStructurallyBroken('legacy:groq', Date.now(), purpose)
    const chain = resolveConfiguredChain(purpose)
    // Two steps since BUG-159. What matters is that the unusable default no
    // longer LEADS: it is demoted behind a step that can actually answer, and
    // deliberately still present so it can earn its place back with a success.
    expect(chain).toHaveLength(2)
    expect(chain[0].providerId).not.toBe('groq')
    expect(chain.map((s) => s.catalogId)).toContain('legacy:groq')
  })

  it.each(LIVE)('%s: substitutes when the default is RATE-LIMITED', (purpose) => {
    markRateLimited('legacy:groq', 60_000, Date.now(), 'live')
    const chain = resolveConfiguredChain(purpose)
    // Two steps since BUG-159. What matters is that the unusable default no
    // longer LEADS: it is demoted behind a step that can actually answer, and
    // deliberately still present so it can earn its place back with a success.
    expect(chain).toHaveLength(2)
    expect(chain[0].providerId).not.toBe('groq')
    expect(chain.map((s) => s.catalogId)).toContain('legacy:groq')
  })

  it('a break recorded for ANOTHER purpose does not substitute this one', () => {
    // Structural breaks are purpose-scoped and must stay that way: a provider
    // that cannot serve summaries may serve cues perfectly well.
    markStructurallyBroken('legacy:groq', Date.now(), 'summary')
    const chain = resolveConfiguredChain('coaching-cue')
    expect(chain[0].catalogId).toBe('legacy:groq')
  })

  it('does not hand back a substitute that is ITSELF benched', () => {
    // The third live call found this: once substitution started firing it
    // returned the same first candidate every few seconds, because
    // stepsFromIds() filters knownStale and credentials but knows nothing
    // about cooldowns or structural breaks. The step that had just been
    // benched for returning a 400 was re-picked immediately, eight times.
    process.env.CLOUDFLARE_API_KEY = 'cf'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
    markPeriodExhausted('legacy:groq', undefined, Date.now(), 'live')
    markStructurallyBroken('cerebras-gpt-oss-120b', Date.now(), 'coaching-cue')

    const chain = resolveConfiguredChain('coaching-cue')
    // ASSERTS ORDER, NOT LENGTH, since BUG-159. The tail now PARTITIONS rather
    // than filtering: attemptable steps take the capped slots and the rest are
    // appended behind them, because soonestExpiry and rescueSteps read this
    // same list to compute the actionable wait time and to offer a never-tried
    // key. So the chain is legitimately longer than the attempt cap — what
    // matters is which step is FIRST, and the walk's own usability gate is what
    // bounds attempts.
    expect(chain[0].providerId).not.toBe('groq') // the exhausted default
    expect(chain[0].providerId).not.toBe('cerebras') // the benched substitute
    // Both are still present — demoted, never deleted, so either can earn its
    // place back with a success.
    expect(chain.map((s) => s.providerId)).toContain('groq')
  })

  it('with NO other provider keyed, it keeps the default rather than returning nothing', () => {
    // Degrading to an empty chain would turn a bad attempt into no attempt --
    // exactly the silent failure this bug produced in the field.
    // BUG-159 added google and openrouter to the live lane, so those keys must
    // go too for this to mean "no other provider" — the beforeEach sets them.
    delete process.env.CEREBRAS_API_KEY
    delete process.env.GOOGLE_AI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    markPeriodExhausted('legacy:groq', undefined, Date.now(), 'live')
    const chain = resolveConfiguredChain('coaching-cue')
    expect(chain).toHaveLength(1)
    expect(chain[0].catalogId).toBe('legacy:groq')
  })
})
