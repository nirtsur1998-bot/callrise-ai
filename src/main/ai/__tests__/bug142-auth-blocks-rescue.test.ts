// BUG-142 (2026-08-30) — a provider with a BAD KEY cannot be rescued, and a
// provider that is merely rate-limited can.
//
// THE FIELD FAILURE. The founder pasted a Cloudflare token that Cloudflare
// rejects. Post-call summaries then stopped working entirely — "Every
// configured key was rejected" — while a known-good Hugging Face key sat
// connected on the same account. `ai-fallback-events.jsonl` recorded it
// fifteen times, identically: `legacy:cloudflare -> null`, reason `auth`.
//
// WHAT THE ORIGINAL BUG ENTRY BLAMED, AND WHY THAT WAS WRONG. The entry
// pinned it on a LEGACY_TAIL_MAX inversion: `summary` has a tail of 3 and ran
// out, `other` has 1 and fell through. A third purpose in the same log breaks
// that story — `memory-extract` also has a tail of 3 and fell through fine.
// Tail length is not the variable, and neither is the failure reason (`other`
// also failed with `auth`). Recorded here because a wrong mechanism in a bug
// entry costs the next reader more than no mechanism at all.
//
// THE ACTUAL MECHANISM, which this file pins:
//   • `rescueSteps()` is gated on `chain.length === 0` — the PRE-WALK state.
//   • `chain = capable.filter(isUsableFor(...))`, and `isUsableFor` excludes a
//     model only if something PERSISTED a cooldown or a structural break.
//   • An `auth` failure deliberately persists NEITHER. It is handled by
//     `deadProviders`, a Set declared INSIDE the walk (complete-with-fallback
//     .ts) and thrown away when the walk ends, and it is explicitly excluded
//     from `markStructurallyBroken` ("failureClass === 'structural' && reason
//     !== 'auth'").
//   • So a bad-key provider is never benched ACROSS walks. Its legacy step
//     stays "usable" forever, `chain.length` is 1 rather than 0, the rescue
//     never fires, the walk kills the provider in-walk and runs out of chain.
//
// THE PERVERSITY THIS PRODUCES, and the reason this is worth a test rather
// than a one-line patch: **the more permanent the failure, the less likely the
// rescue.** A rate limit — temporary, self-healing — persists a cooldown, so
// the next walk starts with an empty chain and the rescue fires. A wrong key —
// permanent until a human retypes it — persists nothing, so the rescue can
// never fire. BUG-125b built the rescue precisely so that "add another
// provider key" would be true advice; it does not hold for the single most
// common way a key is wrong, which is that it is wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError } from '../types'

const activeProviderId = { current: 'cloudflare' as string | null }
const attempts: string[] = []

// How the bad provider fails, switchable per test. A MUTABLE flag rather than
// a second `vi.doMock` behind `vi.resetModules()`, and that is not a style
// preference — the resetModules version SILENTLY BROKE THE TEST. `classify-
// Reason` uses `err instanceof AIProviderError`; after resetModules the mock
// threw the class from a different module instance, `instanceof` returned
// false, and every rate-limit was reclassified as a generic 'failed'. The
// symptom looked exactly like a product bug ("failed: cloudflare is rate
// limited") and would have sent the fix in the wrong direction.
const behavior = { badKeyFails: 'auth' as 'auth' | 'rate-limit' }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../purpose-health-store', () => ({
  recordAiFailure: vi.fn(async () => {}),
  recordAiSuccess: vi.fn(async () => {})
}))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
// No catalog entries for either provider — matching the founder's real config,
// where the purpose has no explicit assignment and Cloudflare/Hugging Face
// enter a chain only as the legacy step or as a rescue step.
vi.mock('../model-catalog', () => ({ catalogEntry: () => null }))

vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string, bad: boolean) => ({
    displayName: id,
    keyEnvName,
    requiredEnvNames: [] as string[],
    build: () => ({
      id,
      displayName: id,
      complete: async () => {
        attempts.push(id)
        if (bad) throw new AIProviderError(behavior.badKeyFails, `${id} rejected the request`)
        return { text: 'rescued', usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } }
      }
    })
  })
  return {
    PROVIDER_REGISTRY: {
      // The bad key the founder pasted.
      cloudflare: make('cloudflare', 'CLOUDFLARE_API_KEY', true),
      // The working key that was connected the whole time.
      huggingface: make('huggingface', 'HUGGINGFACE_API_KEY', false)
    }
  }
})

const { loadAppSettings } = await import('../../app-settings')
const { completeWithFallback } = await import('../complete-with-fallback')
const { resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')

// Every purpose present with an EMPTY chain. `resolveConfiguredChain` reads
// `aiModelAssignments[purpose].chain` directly, so an ABSENT purpose throws
// rather than behaving like "no assignment" — the first draft of this fixture
// returned `{}` and produced a TypeError that looked nothing like the bug.
// Same list the other chain tests use.
const PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]

/** No explicit model assignment for any purpose — the founder's actual state,
 *  and the default on a fresh install. */
function allEmpty(): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: Object.fromEntries(PURPOSES.map((p) => [p, { chain: [] }]))
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  attempts.length = 0
  // Reset the failure mode too — without this the rate-limit test would leak
  // into whatever runs after it, and a leaked reason class is exactly the kind
  // of cross-test contamination that makes one of these files intermittent.
  behavior.badKeyFails = 'auth'
  resetCooldownsForTests()
  resetPacingForTests()
  activeProviderId.current = 'cloudflare'
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
  process.env.CLOUDFLARE_API_KEY = 'a-token-cloudflare-rejects'
  process.env.HUGGINGFACE_API_KEY = 'a-working-key'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('BUG-142 — a bad key must not be able to block the rescue', () => {
  it('THE FIELD CASE: summary with a rejected key and a working second key still answers', async () => {
    const res = await completeWithFallback({ purpose: 'summary', messages: [] } as never)

    // The working provider must have been reached. Asserting on the ATTEMPT
    // list rather than only on the result, so a pass cannot come from the
    // wrong provider having answered.
    expect(attempts).toContain('huggingface')
    expect((res as { text: string }).text).toBe('rescued')
  })

  it('and it stays broken on every later attempt, which is what the field saw 15 times', async () => {
    // The field signature was not one failure — it was the SAME failure
    // repeating, because nothing about the bad key persists between walks.
    // A fix that only works on the second attempt would still be broken.
    for (let i = 0; i < 3; i++) {
      attempts.length = 0
      const res = await completeWithFallback({ purpose: 'summary', messages: [] } as never)
      expect((res as { text: string }).text, `walk ${i + 1} did not reach a working key`).toBe(
        'rescued'
      )
    }
  })

  it('CONTRAST — a RATE LIMIT is rescued on the SECOND walk; auth is never rescued on any', async () => {
    // THIS CONTROL ALREADY EARNED ITS KEEP. Its first draft asserted that the
    // same config with a rate limit "is already rescued today", to show the
    // defect was specific to `auth`. It went RED — and that falsified the
    // diagnosis rather than the test.
    //
    // The corrected mechanism, which is broader and simpler than auth:
    // `rescueSteps()` is gated on the PRE-WALK chain being empty, so it can
    // never rescue a walk that STARTED with a usable-looking step and then
    // exhausted it. On walk 1 nothing is cooling yet, so chain = [legacy:bad]
    // and no rescue is offered — for auth AND for rate-limit alike.
    //
    // What `auth` changes is PERMANENCE, not the gate. A rate limit persists a
    // cooldown, so walk 2 starts with an empty chain and IS rescued. An auth
    // failure persists nothing (deadProviders is per-walk; markStructurally-
    // Broken explicitly skips `auth`), so every subsequent walk looks exactly
    // like walk 1 and the rescue can never fire. That is why the field saw the
    // identical failure fifteen times instead of once.
    behavior.badKeyFails = 'rate-limit'

    // Walk 1: no rescue, for the same pre-walk-gate reason as the auth case.
    await expect(
      completeWithFallback({ purpose: 'summary', messages: [] } as never)
    ).rejects.toThrow()

    // Walk 2: the rate limit PERSISTED a cooldown, so the chain is now empty
    // pre-walk and the rescue fires. This is the behaviour the auth case can
    // never reach, and it is what makes a bad key worse than a rate limit.
    attempts.length = 0
    const res = await completeWithFallback({ purpose: 'summary', messages: [] } as never)
    expect((res as { text: string }).text).toBe('rescued')
    expect(attempts).toContain('huggingface')
  })
})
