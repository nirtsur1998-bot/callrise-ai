// BUG-154 — "it needs to eventually try ALL the saved keys and APIs in the
// system if one fails FOR WHATEVER REASON." (founder, 2026-09-01)
//
// This file is that sentence, executable.
//
// The requirement is about EVENTUALLY, not about one walk: the two live
// purposes are capped at a single attempt on purpose (LEGACY_TAIL_MAX 0, the
// founder's own latency constraint from BUG-148 5B), so "try everything" can
// only mean across successive attempts, as failures bench models and the next
// usable one moves up.
//
// What actually blocked that was not the cap. It was that a failure which
// never escalates never benches anything, so resolution returned the SAME
// first candidate forever and the other keys were never reached. Measured in
// the field: twelve identical failures on one model across two real calls
// while three other providers sat configured and untried.
//
// The loop below is deliberately mechanical: resolve, fail whatever came back,
// repeat. No provider list is hand-written anywhere in the assertions -- the
// expected set is derived from the keys that are configured, so a provider
// added later is covered without editing this file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const activeProviderId = { current: 'groq' as string | null }
vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))

const { loadAppSettings } = await import('../../app-settings')
const { resolveConfiguredChain } = await import('../complete-with-fallback')
const { noteTransientFailure, resetCooldownsForTests } = await import('../model-cooldown')

const ORIGINAL_ENV = { ...process.env }

/** Every purpose empty, so resolution takes the legacy + bundled path. */
function allEmpty(): { aiModelAssignments: Record<string, { chain: string[] }> } {
  return new Proxy(
    { aiModelAssignments: {} as Record<string, { chain: string[] }> },
    {
      get(t, p) {
        if (p !== 'aiModelAssignments') return (t as Record<string | symbol, unknown>)[p]
        return new Proxy({} as Record<string, { chain: string[] }>, {
          get: () => ({ chain: [] as string[] })
        })
      }
    }
  ) as { aiModelAssignments: Record<string, { chain: string[] }> }
}

const KEYED: Array<[string, string]> = [
  ['groq', 'GROQ_API_KEY'],
  ['cerebras', 'CEREBRAS_API_KEY'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['huggingface', 'HUGGINGFACE_API_KEY']
]

beforeEach(() => {
  resetCooldownsForTests()
  activeProviderId.current = 'groq'
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty() as never)
  process.env = { ...ORIGINAL_ENV }
  for (const [, env] of KEYED) process.env[env] = 'test-key'
})
afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('every configured key is eventually attempted, whatever the failure', () => {
  it('coaching-cue reaches EVERY keyed provider across successive attempts', () => {
    const expected = new Set(KEYED.map(([p]) => p))
    const seen = new Set<string>()

    // Resolve, fail whatever it returns, resolve again. Bounded well above the
    // provider count so a genuine failure to converge shows as a missing
    // provider rather than as a hang.
    for (let attempt = 0; attempt < 60; attempt++) {
      const chain = resolveConfiguredChain('coaching-cue')
      if (chain.length === 0) break
      for (const step of chain) {
        seen.add(step.providerId)
        // A transient failure -- the "for whatever reason" case, and the exact
        // class that used to loop forever without benching anything.
        noteTransientFailure(step.catalogId, Date.now(), 'coaching-cue')
      }
      if (expected.size === [...seen].filter((p) => expected.has(p)).length) break
    }

    const missed = [...expected].filter((p) => !seen.has(p))
    expect(missed, `never attempted despite holding a key: ${missed.join(', ')}`).toEqual([])
  })

  // WAS a known gap, marked it.fails. CLOSED by BUG-159: a benched model used
  // to hold one of the capped tail slots forever, so anything behind it was
  // unreachable. The tail now PARTITIONS — attemptable steps compete for the
  // slots, the rest are appended behind them so soonestExpiry and rescueSteps
  // can still see them — which frees the slot without stripping information
  // the wait-time message depends on.
  it('the same holds for a DURABLE purpose, which has a tail', () => {
    const expected = new Set(KEYED.map(([p]) => p))
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 60; attempt++) {
      const chain = resolveConfiguredChain('summary')
      if (chain.length === 0) break
      for (const step of chain) {
        seen.add(step.providerId)
        noteTransientFailure(step.catalogId, Date.now(), 'summary')
      }
      if (expected.size === [...seen].filter((p) => expected.has(p)).length) break
    }
    const missed = [...expected].filter((p) => !seen.has(p))
    expect(missed, `never attempted despite holding a key: ${missed.join(', ')}`).toEqual([])
  })

  it('CONTROL: with one key removed, that provider is NOT attempted', () => {
    // Without this the tests above could pass because everything is attempted
    // indiscriminately rather than because credentials are respected.
    delete process.env['ANTHROPIC_API_KEY']
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 40; attempt++) {
      const chain = resolveConfiguredChain('coaching-cue')
      if (chain.length === 0) break
      for (const step of chain) {
        seen.add(step.providerId)
        noteTransientFailure(step.catalogId, Date.now(), 'coaching-cue')
      }
    }
    expect(seen.has('anthropic')).toBe(false)
  })
})
