// BUG-154 — a key the app ACCEPTS must be a key some feature can USE.
//
// The bug this file exists to prevent: `anthropic` and `openai` had been
// accepted providers since M16 and had NO catalog entry at all. Every fallback
// chain is built from catalog ids, so neither could ever serve a bundled step
// for any purpose — reachable only as the single pinned "default text AI
// provider". The founder reported dead live coaching cues from a machine
// holding TWELVE keys including a paid Anthropic one. None of them could be
// reached: coaching-cue's chain is one step, and its substitute pool was
// SPEED_CHAIN, which was groq+cerebras only.
//
// Three separate documents had already written down a piece of this — the two
// groq-llama catalog entries' own "queued as the immediate follow-up" note,
// and bug149-assign-chain.test.ts's header ("whose two survivors are BOTH
// Groq"). None of them was a TEST, so none of them could fail. That is the
// whole point of this file.
//
// Every assertion below ENUMERATES ITS CONTAINER — it iterates
// AI_PROVIDER_IDS / MODEL_CATALOG / every purpose, never a hand-written list
// of the providers that happen to be broken today. A list I typed cannot fail
// on a provider nobody thought of, which is precisely how this shipped.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AI_PROVIDER_IDS, CHAIN_BUDGET, type AIPurpose } from '../types'
import { MODEL_CATALOG } from '../model-catalog'
import { DEFAULT_CATALOG_CHAIN, CANDIDATE_POOL } from '../complete-with-fallback'

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const live = MODEL_CATALOG.filter((e) => !e.knownStale)
const byId = new Map(MODEL_CATALOG.map((e) => [e.id, e]))
const purposes = Object.keys(DEFAULT_CATALOG_CHAIN) as AIPurpose[]

/** Every catalog id reachable through any purpose's bundled chain. */
const chainedIds = new Set<string>(
  purposes.flatMap((p) => [...DEFAULT_CATALOG_CHAIN[p], ...(CANDIDATE_POOL[p] ?? [])])
)

describe('every accepted provider is reachable by some chain', () => {
  it('each provider has at least one LIVE catalog entry', () => {
    const missing = AI_PROVIDER_IDS.filter(
      (p) => !live.some((e) => e.providerId === p)
    )
    expect(missing, `providers with no live catalog entry: ${missing.join(', ')}`).toEqual([])
  })

  it('each provider is reachable through a bundled chain, not only as the pinned default', () => {
    // The exact defect: a provider absent from every chain can only ever be
    // used if the user happens to have pinned it as their default text
    // provider. Any other configuration leaves its key inert.
    const unreachable = AI_PROVIDER_IDS.filter(
      (p) => !live.some((e) => e.providerId === p && chainedIds.has(e.id))
    )
    expect(
      unreachable,
      `keys accepted but unusable by any fallback chain: ${unreachable.join(', ')}`
    ).toEqual([])
  })
})

describe('no chain references a model that cannot run', () => {
  it('every chained id exists in the catalog', () => {
    const ghosts = [...chainedIds].filter((id) => !byId.has(id))
    expect(ghosts, `chain ids with no catalog entry: ${ghosts.join(', ')}`).toEqual([])
  })

  it('every purpose keeps at least one LIVE step after the knownStale filter', () => {
    // A chain made entirely of knownStale ids resolves to nothing while still
    // LOOKING configured — the shape that made cues silently unavailable.
    const dead = purposes.filter(
      (p) => !DEFAULT_CATALOG_CHAIN[p].some((id) => byId.get(id) && !byId.get(id)!.knownStale)
    )
    expect(dead, `purposes whose whole default chain is dead: ${dead.join(', ')}`).toEqual([])
  })
})

describe('an attempts cap can never mean zero attempts', () => {
  // The cap used to be applied by slicing the RAW id list
  // (`SPEED_CHAIN.slice(0, 2)`), i.e. BEFORE the knownStale filter. When the
  // first two ids went dead, a cap of 2 resolved to ZERO usable models. The
  // cap now lives in bundledSteps() and applies to resolved steps.
  it.each(Object.keys(CHAIN_BUDGET) as AIPurpose[])(
    '%s has at least `cap` live entries available before capping',
    (purpose) => {
      const cap = CHAIN_BUDGET[purpose]!.maxChainLength
      const liveInChain = DEFAULT_CATALOG_CHAIN[purpose].filter(
        (id) => byId.get(id) && !byId.get(id)!.knownStale
      )
      expect(liveInChain.length).toBeGreaterThanOrEqual(cap)
    }
  )

  it('the raw-list slice is gone from the chain definitions', () => {
    const src = stripComments(read('src/main/ai/complete-with-fallback.ts'))
    expect(src).not.toMatch(/SPEED_CHAIN\.slice\(/)
  })
})

describe('a live purpose can cross providers', () => {
  it.each(Object.keys(CHAIN_BUDGET) as AIPurpose[])(
    '%s can reach more than one provider',
    (purpose) => {
      // BUG-149 found the previous version of this: both survivors inside the
      // cap were Groq, so a demoted Groq default fell back to itself.
      const provs = new Set(
        (CANDIDATE_POOL[purpose] ?? [])
          .map((id) => byId.get(id))
          .filter((e) => e && !e.knownStale)
          .map((e) => e!.providerId)
      )
      expect(provs.size).toBeGreaterThan(1)
    }
  )
})

describe('ModelBrand is duplicated in the renderer and nothing pinned it', () => {
  // ModelLogo.tsx declares its own copy of ModelBrand because the renderer
  // cannot import from main. Its comment says "keep in lockstep"; a comment
  // cannot fail. Adding 'anthropic' to main and not the copy was caught here
  // only because BRAND_LABEL is a total Record — a Partial would have shipped.
  const union = (src: string, name: string): string[] => {
    const clean = stripComments(src)
    const head = `export type ${name} =`
    const start = clean.indexOf(head)
    if (start < 0) throw new Error(`could not find type ${name}`)
    const rest = clean.slice(start + head.length)
    const end = rest.search(/\n\s*\n/)
    return [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/'([^']+)'/g)].map((x) => x[1])
  }

  it('the two ModelBrand declarations carry exactly the same members', () => {
    const mainBrands = union(read('src/main/ai/model-catalog.ts'), 'ModelBrand')
    const rendererBrands = union(read('src/renderer/src/components/ModelLogo.tsx'), 'ModelBrand')
    expect([...rendererBrands].sort()).toEqual([...mainBrands].sort())
  })

  it('every brand used by a catalog entry is a declared brand', () => {
    const declared = new Set(union(read('src/main/ai/model-catalog.ts'), 'ModelBrand'))
    const used = [...new Set(MODEL_CATALOG.map((e) => e.brand))]
    expect(used.filter((b) => !declared.has(b))).toEqual([])
  })
})
