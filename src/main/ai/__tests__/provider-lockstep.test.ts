import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AI_PROVIDER_IDS } from '../types'

/**
 * M31 — the preload copies of AiProviderId / AiKeyName cannot import from
 * main (different process, different bundle), so they are hand-maintained
 * duplicates of lists that live in src/main. Nothing in the compiler relates
 * the two: adding a provider to main and forgetting preload leaves the app
 * building cleanly while the renderer cannot name the new provider, so its
 * "Test key" button and its save call are unreachable through the typed
 * bridge. This test is the relationship the type system cannot express.
 *
 * It also covers the third and fourth copies — the three INLINE unions in
 * preload/index.ts (save / clear / validate), which are separate literals
 * from the exported types in index.d.ts and have to be extended alongside
 * them.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY MATCH, and that is not a detail. This
 * directory's own latencyPolicy.test.ts records the exact failure: a source
 * scan kept passing because a DOC COMMENT contained the string it searched
 * for. The M31 edit that prompted this file added comments to both preload
 * files naming 'zai' and 'huggingface' in prose — so an unstripped scan here
 * would pass on the comment alone, while the actual union was missing them.
 * The trap was one line away, and it is the same trap, in the same directory.
 */

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** The string literals inside `<name> = [ ... ]`. */
function arrayLiterals(src: string, name: string): string[] {
  const m = stripComments(src).match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`))
  if (!m) throw new Error(`could not find array literal ${name}`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** The string literals in `export type <name> = 'a' | 'b'`, up to the blank
 *  line that ends the declaration. */
function unionLiterals(src: string, name: string): string[] {
  const clean = stripComments(src)
  const head = `export type ${name} =`
  const start = clean.indexOf(head)
  if (start < 0) throw new Error(`could not find type ${name}`)
  const rest = clean.slice(start + head.length)
  const end = rest.search(/\n\s*\n/)
  return [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** The literals in one inline parameter union, located by the IPC channel it
 *  is passed to — precise enough that an unrelated 'openai' elsewhere in the
 *  file cannot satisfy the assertion. */
function inlineUnion(src: string, channel: string): string[] {
  const clean = stripComments(src)
  const end = clean.indexOf(`ipcRenderer.invoke('${channel}'`)
  if (end < 0) throw new Error(`could not find invoke of ${channel}`)
  // Walk back to the start of this argument list.
  const start = clean.lastIndexOf('(', clean.lastIndexOf('=>', end))
  return [...clean.slice(start, end).matchAll(/'([^']+)'/g)].map((x) => x[1])
}

const MAIN_KEYS = arrayLiterals(read('src/main/ai-keys.ts'), 'AI_KEY_NAMES')
const PRELOAD_D = read('src/preload/index.d.ts')
const PRELOAD_JS = read('src/preload/index.ts')

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

describe('main and preload agree on the provider list', () => {
  it('preload AiProviderId matches main AI_PROVIDER_IDS exactly', () => {
    expect(sorted(unionLiterals(PRELOAD_D, 'AiProviderId'))).toEqual(sorted(AI_PROVIDER_IDS))
  })

  it('preload AiKeyName matches main AI_KEY_NAMES exactly', () => {
    expect(sorted(unionLiterals(PRELOAD_D, 'AiKeyName'))).toEqual(sorted(MAIN_KEYS))
  })
})

describe("preload's inline bridge unions carry every value", () => {
  it('aiKeys:save accepts every key name', () => {
    expect(sorted(inlineUnion(PRELOAD_JS, 'aiKeys:save'))).toEqual(sorted(MAIN_KEYS))
  })

  it('aiKeys:clear accepts every key name', () => {
    // A key that can be saved but not cleared strands the user with a bad key
    // and no way to remove it from the UI.
    expect(sorted(inlineUnion(PRELOAD_JS, 'aiKeys:clear'))).toEqual(sorted(MAIN_KEYS))
  })

  it('aiKeys:validate accepts every provider id', () => {
    // This one backs the "Test key" button — a provider missing here has a
    // card that saves a key and can never confirm it works.
    expect(sorted(inlineUnion(PRELOAD_JS, 'aiKeys:validate'))).toEqual(sorted(AI_PROVIDER_IDS))
  })
})

describe('every provider is wired end to end', () => {
  it('each registry entry names a key that actually exists', () => {
    // keyEnvName is a plain `string` on ProviderRegistryEntry, so a typo here
    // compiles and then reads an env var nobody ever writes.
    const registry = stripComments(read('src/main/ai/registry.ts'))
    const named = [...registry.matchAll(/keyEnvName:\s*'([^']+)'/g)].map((m) => m[1])
    expect(named.length).toBe(AI_PROVIDER_IDS.length)
    for (const key of named) expect(MAIN_KEYS).toContain(key)
  })

  it('every provider id used by the model catalog is a real provider', () => {
    const catalog = stripComments(read('src/main/ai/model-catalog.ts'))
    const used = new Set([...catalog.matchAll(/providerId:\s*'([^']+)'/g)].map((m) => m[1]))
    for (const id of used) expect(AI_PROVIDER_IDS).toContain(id)
  })
})
