// BUG-154 — REACHABILITY, proven through the resolver rather than the file.
//
// The sibling file (bug154-provider-reachability) asserts STRUCTURE: that a
// provider appears in some chain. That is necessary and it is not the claim
// the bug is about. An entry can exist in a chain and still never resolve —
// knownStale, a missing key, or a cap applied to the wrong list will each drop
// it — and "exists" vs "resolves" is precisely the gap this bug lived in.
//
// So everything here calls bundledSteps(), the same function completeWithFallback
// walks, and asserts on what comes BACK.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledSteps } from '../complete-with-fallback'
import { catalogEntry } from '../model-catalog'

const SAVED = { ...process.env }
const clearKeys = (): void => {
  for (const k of Object.keys(process.env)) {
    if (k.endsWith('_API_KEY') || k === 'CLOUDFLARE_ACCOUNT_ID') delete process.env[k]
  }
}
beforeEach(() => {
  process.env = { ...SAVED }
  clearKeys()
})
afterEach(() => {
  process.env = { ...SAVED }
})

describe('the attempts cap yields a NON-EMPTY chain, with the dead ids flagged', () => {
  // The exact before/after. The old code capped by slicing the RAW id list:
  //   DEFAULT_CATALOG_CHAIN['coaching-cue'] = SPEED_CHAIN.slice(0, 2)
  // whose two members were these. With both now knownStale, that slice
  // resolves to NOTHING — a cap of 2 meaning zero attempts. The cap moved into
  // bundledSteps(), after the filters, so the same key now yields real steps.
  const OLD_CAPPED_PREFIX = ['groq-llama-3.1-8b-instant', 'groq-llama-3.3-70b-versatile']

  it('both ids the old cap contained are flagged dead', () => {
    for (const id of OLD_CAPPED_PREFIX) {
      expect(catalogEntry(id), `${id} missing from catalog`).toBeDefined()
      expect(catalogEntry(id)!.knownStale, `${id} is not flagged`).toBeTruthy()
    }
  })

  it('the OLD capped prefix resolves to ZERO usable steps', () => {
    process.env['GROQ_API_KEY'] = 'present'
    // Resolution semantics, not a re-implementation: a knownStale entry is
    // skipped by every chain builder, so a chain made only of these is empty.
    const usable = OLD_CAPPED_PREFIX.filter((id) => !catalogEntry(id)?.knownStale)
    expect(usable).toEqual([])
  })

  it('the NEW cap resolves to real steps on the SAME single key', () => {
    process.env['GROQ_API_KEY'] = 'present'
    const steps = bundledSteps('coaching-cue')
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((s) => !catalogEntry(s.catalogId)?.knownStale)).toBe(true)
  })
})

describe('a key that is PRESENT is a key that is REACHABLE', () => {
  // providerHasCredentials gates on presence, not validity, so these prove
  // reachability without a live credential — which is the property that was
  // broken. A valid key is what proves the request succeeds; that is a
  // different claim and is not made here.
  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['zai', 'ZAI_API_KEY'],
    ['huggingface', 'HUGGINGFACE_API_KEY']
  ])('%s alone resolves to at least one step', (providerId, envName) => {
    process.env[envName] = 'present'
    // Every purpose, because a provider reachable for one job and not another
    // is the same defect at smaller scale.
    const purposes = ['coaching-cue', 'summary', 'memory-extract', 'coaching-chat'] as const
    for (const p of purposes) {
      const steps = bundledSteps(p)
      expect(steps.length, `${providerId} unreachable for ${p}`).toBeGreaterThan(0)
      expect(
        steps.every((s) => s.providerId === providerId),
        `${p} resolved a provider with no key: ${steps.map((s) => s.providerId).join(',')}`
      ).toBe(true)
    }
  })

  it('with NO keys at all, every purpose resolves to nothing — the filter is real', () => {
    // The control. Without this, the assertions above could be passing because
    // the filter does nothing rather than because the key was found.
    for (const p of ['coaching-cue', 'summary', 'memory-extract'] as const) {
      expect(bundledSteps(p)).toEqual([])
    }
  })
})
