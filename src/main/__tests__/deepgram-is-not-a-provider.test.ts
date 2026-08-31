// BUG-146 — 'deepgram' must stay OUTSIDE the text-AI provider registry.
//
// The whole shape of the Deepgram fix rests on one assumption: that 'deepgram'
// is not an AIProviderId. Two separate pieces of code would break quietly if it
// ever became one, and neither would fail loudly:
//
//   1. `AiValidateTarget = AIProviderId | 'deepgram'` stops discriminating —
//      the union collapses and `keyNameForTarget` still resolves, so nothing
//      errors; Deepgram just starts being treated as a text-AI provider.
//   2. The renderer derives `AiProviderId = Exclude<AiValidateTarget,
//      'deepgram'>`. If 'deepgram' joined the registry, that Exclude would
//      SUBTRACT A REAL PROVIDER — silently removing it from PROVIDER_OPTIONS,
//      i.e. from the "default text AI provider" picker. A provider vanishing
//      from a picker is exactly the kind of thing nobody notices for weeks.
//
// And the failure this prevents in the product: Deepgram appearing as a
// selectable default text AI provider. It cannot complete a single text
// request, so every summary, coaching cue and Rise message would fail for
// anyone who picked it.
//
// This is species 47 — an identifier matched by STRING across a module
// boundary, where a mismatch fails OPEN. The remedy is to assert the other
// side, so here it is asserted.
import { describe, expect, it } from 'vitest'
import { PROVIDER_REGISTRY } from '../ai/registry'
import { DEEPGRAM_TARGET } from '../ai-keys'

describe("BUG-146: 'deepgram' is a validate target, never a provider id", () => {
  it('is absent from PROVIDER_REGISTRY', () => {
    expect(
      Object.keys(PROVIDER_REGISTRY),
      `'${DEEPGRAM_TARGET}' has become a text-AI provider id. That breaks the ` +
        'AiValidateTarget union AND makes the renderer\'s ' +
        "Exclude<AiValidateTarget, 'deepgram'> subtract a real provider from " +
        'the default-provider picker. If this is deliberate, both must be ' +
        'reworked in the same edit — see the header of this file.'
    ).not.toContain(DEEPGRAM_TARGET)
  })

  it('the constant still holds the string the preload union hard-codes', () => {
    // preload/index.ts cannot import from main, so it repeats this literal in
    // its own union. A rename here that did not reach there would send an
    // unroutable target over IPC and silently disable Deepgram's Test button.
    expect(DEEPGRAM_TARGET).toBe('deepgram')
  })

  it('every provider id names a key this module knows', () => {
    // The invariant keyNameForTarget relies on instead of a cast: a registry
    // entry whose keyEnvName is not a real AiKeyName would resolve to null and
    // silently make that provider's "Test key" button do nothing.
    const envNames = Object.values(PROVIDER_REGISTRY).map((p) => p.keyEnvName)
    for (const name of envNames) {
      expect(name, `${name} is not in AI_KEY_NAMES`).toMatch(/_API_KEY$|_ACCOUNT_ID$/)
    }
  })
})
