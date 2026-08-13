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
    // groq's defaultModel is byte-identical to catalog entry
    // groq-llama-3.3-70b-versatile's modelId. Without the guard, a single-key
    // user's attempt 1 and a later "fallback" are literally the same request.
    const legacyModel = PROVIDER_REGISTRY.groq.defaultModelId
    expect(legacyModel).toBe('llama-3.3-70b-versatile') // pin the premise
    const steps = resolveConfiguredChain('memory-extract')
    expect(steps.slice(1).map((s) => s.modelId)).not.toContain(legacyModel)
  })

  it('a single-key user gets AT MOST ONE same-provider retry, and it is not a duplicate', () => {
    // The user requirement: "for a single-key user, 'fall back to the bundled
    // chain' is just slower failure." One extra attempt on a DIFFERENT model
    // of the same key is justified (Groq/Gemini rate-limit per-model); a
    // parade of them is not.
    delete process.env.GOOGLE_AI_API_KEY
    delete process.env.OPENROUTER_API_KEY

    const steps = resolveConfiguredChain('memory-extract')
    const tail = steps.slice(1)

    expect(tail.length).toBe(1)
    expect(tail[0].providerId).toBe('groq')
    expect(tail[0].modelId).not.toBe(PROVIDER_REGISTRY.groq.defaultModelId)
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
    for (const p of ['summary', 'scorecard', 'memory-extract', 'deal-tier2'] as AIPurpose[]) {
      expect(resolveConfiguredChain(p).length).toBeLessThanOrEqual(4)
    }
  })

  it('interactive purposes where a human is waiting get exactly one extra', () => {
    for (const p of ['other', 'coaching-chat'] as AIPurpose[]) {
      expect(resolveConfiguredChain(p).length).toBeLessThanOrEqual(2)
    }
  })

  it('LIVE purposes are untouched — still exactly one attempt, no tail', () => {
    // Achieved by exclusion, not budget arithmetic: chain.length stays 1, so
    // the per-attempt budget split in completeWithFallback is bit-identical
    // to today. This is what makes P1 provably zero-risk for M9's dead-air
    // fix and M24's <=4s criterion.
    expect(resolveConfiguredChain('coaching-cue')).toHaveLength(1)
    expect(resolveConfiguredChain('deal-tier1')).toHaveLength(1)
    expect(resolveConfiguredChain('coaching-cue')[0].catalogId).toBe('legacy:groq')
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
