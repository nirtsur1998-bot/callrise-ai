// BUG-159 — no AI feature should hang on ONE provider when the user holds several.
//
// Founder: "this bug with AI usage is all across the app ... CallRise AI depends
// on that." So this file asks the question of EVERY purpose at once, rather than
// of whichever feature was last reported broken.
//
// Measured against the founder's real key set (anthropic, cloudflare, groq,
// huggingface, with huggingface pinned as the default provider), 2026-09-01:
//
//     coaching-cue          1 step   huggingface          <-- single point of failure
//     deal-tier1            1 step   huggingface          <-- single point of failure
//     other                 2 steps  huggingface, groq
//     coaching-chat         2 steps  huggingface, groq
//     everything else       4 steps  huggingface, groq, cloudflare, anthropic
//
// Nine of thirteen features can reach the paid Anthropic key. The two that
// cannot are exactly the two the founder reported as broken — and the provider
// they are pinned to is the one out of quota and returning malformed output.
//
// The allowlist below is the POINT of the test. The two live purposes are
// deliberately single-step (LEGACY_TAIL_MAX 0, BUG-148 decision 5B, founder,
// 2026-08-31) to protect the 6s dead-air budget. Listing them explicitly means
// a THIRD purpose becoming single-step fails the build instead of being noticed
// by a user months later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const activeProviderId = { current: 'huggingface' as string | null }
vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))

const { loadAppSettings } = await import('../../app-settings')
const { resolveConfiguredChain } = await import('../complete-with-fallback')
const { LATENCY_POLICY } = await import('../types')
const { CANDIDATE_POOL } = await import('../complete-with-fallback')
const { MODEL_CATALOG } = await import('../model-catalog')

/** Enumerated from LATENCY_POLICY, which is an exhaustive Record over AIPurpose
 *  — so a purpose added later is covered here without editing this file. A
 *  hand-written list could not fail on a purpose nobody thought of, which is
 *  the whole failure mode being guarded. */
const ALL_PURPOSES = Object.keys(LATENCY_POLICY) as Array<keyof typeof LATENCY_POLICY>

/** Deliberately single-step, with the decision that made them so. */
const SINGLE_STEP_BY_DESIGN = new Set(['coaching-cue', 'deal-tier1'])

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  activeProviderId.current = 'huggingface'
  vi.mocked(loadAppSettings).mockReturnValue({
    aiModelAssignments: new Proxy({}, { get: () => ({ chain: [] }) })
  } as never)
  process.env = { ...ORIGINAL_ENV }
  for (const k of Object.keys(process.env)) {
    if (k.endsWith('_API_KEY') || k === 'CLOUDFLARE_ACCOUNT_ID') delete process.env[k]
  }
  process.env['ANTHROPIC_API_KEY'] = 'k'
  process.env['CLOUDFLARE_API_KEY'] = 'k'
  process.env['CLOUDFLARE_ACCOUNT_ID'] = 'acct'
  process.env['GROQ_API_KEY'] = 'k'
  process.env['HUGGINGFACE_API_KEY'] = 'k'
})
afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('with four provider keys configured, no feature depends on one provider', () => {
  it('every purpose outside the documented exceptions survives one provider failing', () => {
    const singlePoint = ALL_PURPOSES.filter((p) => {
      if (SINGLE_STEP_BY_DESIGN.has(p)) return false
      const providers = new Set(resolveConfiguredChain(p as never).map((s) => s.providerId))
      return providers.size < 2
    })
    expect(
      singlePoint,
      `these features die if one provider does: ${singlePoint.join(', ')}`
    ).toEqual([])
  })

  it('CONTROL: the documented exceptions really ARE single-provider', () => {
    // Without this the test above could pass because the allowlist is wrong
    // rather than because the exceptions are real. If either of these ever
    // gains a second provider, remove it from SINGLE_STEP_BY_DESIGN — the
    // failure message says so.
    for (const p of SINGLE_STEP_BY_DESIGN) {
      const providers = new Set(resolveConfiguredChain(p as never).map((s) => s.providerId))
      expect(
        providers.size,
        `${p} now reaches ${providers.size} providers — drop it from SINGLE_STEP_BY_DESIGN`
      ).toBe(1)
    }
  })

  it('the paid provider is ELIGIBLE for every purpose, even where a single walk cannot reach it', () => {
    // CORRECTED, NOT RELAXED. The first version asserted the paid key appears
    // in the RESOLVED chain of every non-exception purpose, and failed naming
    // `other` and `coaching-chat`. That assertion was too strong: those two
    // have LEGACY_TAIL_MAX 1, so ONE walk reaches two providers and anthropic
    // sits further down the lane. Across successive walks, benching rotates it
    // into reach — which bug154-eventually-tries-every-key already proves, so
    // re-asserting it here would have been both wrong and redundant.
    //
    // The invariant that IS this file's business is ELIGIBILITY: a key the user
    // paid for must be a candidate everywhere, even where a given walk's
    // attempt budget stops short of it. Ineligible is a permanent defect;
    // out-of-reach-this-walk is a budget.
    const pools = ALL_PURPOSES.map((p) => ({
      purpose: p,
      eligible: new Set(
        (CANDIDATE_POOL[p as keyof typeof CANDIDATE_POOL] ?? [])
          .map((id) => MODEL_CATALOG.find((e) => e.id === id))
          .filter((e) => e && !e.knownStale)
          .map((e) => e!.providerId)
      )
    }))
    const ineligible = pools.filter((x) => !x.eligible.has('anthropic')).map((x) => x.purpose)
    expect(
      ineligible,
      `the paid provider is not even a CANDIDATE for: ${ineligible.join(', ')}`
    ).toEqual([])
  })
})
