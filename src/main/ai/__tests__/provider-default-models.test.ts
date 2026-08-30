// BUG-081 (2026-08-30) — a provider's LEGACY default model had no staleness
// check of any kind, and nothing noticed for weeks.
//
// THE TWO GAPS THIS PINS.
//
// 1. `PROVIDER_REGISTRY[x].defaultModelId` is the model every LEGACY chain step
//    sends. Bundled catalog entries at least get the static `knownStale` gate in
//    bundledSteps(); the legacy default gets nothing. Groq's was
//    'llama-3.3-70b-versatile', which Groq stopped recognising — so every legacy
//    attempt for a Groq user failed on a dead id. Purposes with a deep fallback
//    tail routed around it invisibly, which is why it survived so long.
//
// 2. `testModel` is what `validateKey` probes with (openai-compatible.ts), so a
//    dead one makes "Test key" report a GOOD key as rejected. BUG-143 then made
//    validateKey load-bearing for auto-selecting the default provider, so the
//    same dead id would also stop a working key from ever being adopted.
//
// THE INVARIANT: no provider may point its default or test model at an id the
// catalog itself flags as stale. That is a contradiction the codebase can hold
// silently — one file says "this id is dead", another sends it on every call —
// and it is exactly the shape that hid here, so it is worth a test rather than
// a comment.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVIDER_REGISTRY } from '../registry'
import { MODEL_CATALOG } from '../model-catalog'
import type { AIProviderId } from '../types'

const staleModelIdsByProvider = new Map<string, Map<string, string>>()
for (const entry of MODEL_CATALOG) {
  if (!entry.knownStale) continue
  const forProvider = staleModelIdsByProvider.get(entry.providerId) ?? new Map()
  forProvider.set(entry.modelId, entry.knownStale)
  staleModelIdsByProvider.set(entry.providerId, forProvider)
}

describe('BUG-081 — no provider ships a default or test model the catalog calls dead', () => {
  const providerIds = Object.keys(PROVIDER_REGISTRY) as AIProviderId[]

  it.each(providerIds)('%s: defaultModelId is not a knownStale catalog id', (id) => {
    const defaultModelId = PROVIDER_REGISTRY[id].defaultModelId
    if (!defaultModelId) return // Anthropic/OpenAI have none — nothing to check.
    const stale = staleModelIdsByProvider.get(id)?.get(defaultModelId)
    expect(
      stale,
      `${id}'s legacy default model is '${defaultModelId}', which the catalog flags as stale: ${stale}. ` +
        'Every legacy chain step for this provider sends that id, and the legacy step has no ' +
        'staleness gate at all — so this fails on every attempt, quietly.'
    ).toBeUndefined()
  })

  // testModel lives inside each provider's *_CONFIG literal rather than on the
  // registry entry, so it is read from the source. Reading the file is uglier
  // than importing a value, and it is the only way to see a field the registry
  // does not re-export — a field being unreachable from outside is precisely
  // why nobody was checking it.
  it('no provider config sets a testModel the catalog flags as stale', () => {
    const src = readFileSync(join(__dirname, '..', 'registry.ts'), 'utf8')
    const configs = [...src.matchAll(/const (\w+)_CONFIG = \{([\s\S]*?)\n\} as const/g)]
    expect(configs.length, 'no *_CONFIG blocks found — did registry.ts change shape?').toBeGreaterThan(0)

    const offenders: string[] = []
    for (const [, name, body] of configs) {
      const id = body.match(/id:\s*'([^']+)'/)?.[1]
      const testModel = body.match(/testModel:\s*'([^']+)'/)?.[1]
      if (!id || !testModel) continue
      const stale = staleModelIdsByProvider.get(id)?.get(testModel)
      if (stale) offenders.push(`${name}_CONFIG.testModel = '${testModel}' — ${stale}`)
    }
    expect(
      offenders,
      'these probe a model the catalog calls dead, so "Test key" would reject a GOOD key — ' +
        'and since BUG-143, would also stop it becoming the default provider'
    ).toEqual([])
  })
})
