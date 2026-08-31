import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AI_PROVIDER_IDS } from '../types'
import { providerHasCredentials } from '../provider-credentials'

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

  it('aiKeys:validate accepts every provider id, plus Deepgram and nothing else', () => {
    // This one backs the "Test key" button — a provider missing here has a
    // card that saves a key and can never confirm it works.
    //
    // BUG-146 made this union a deliberate SUPERSET of the provider ids: it now
    // also carries 'deepgram', which is a validate target but NOT a provider id
    // (Deepgram cannot complete a text request, so it must never reach the
    // default-text-AI-provider picker — see deepgram-is-not-a-provider.test.ts).
    //
    // Kept as an exact toEqual against the expected set rather than softened to
    // toContain. A toContain here would still pass with a provider MISSING,
    // which is the entire failure this test exists to catch — and "corrected,
    // not relaxed" is a claim that has already been wrong in this repo once
    // (2026-08-30, toEqual(['groq']) -> toContain('groq'), which discriminated
    // nothing). Red-checked both ways: dropping a provider fails, and adding an
    // unexpected extra target fails.
    expect(sorted(inlineUnion(PRELOAD_JS, 'aiKeys:validate'))).toEqual(
      sorted([...AI_PROVIDER_IDS, 'deepgram'])
    )
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

describe('the renderer does not keep its own copy of the key list', () => {
  // WHY THIS EXISTS, and it is not hypothetical: the tests above guard main
  // against preload and stopped there. The renderer holds copies too, and one
  // of them — the Home activation checklist — enumerated the eight text-AI key
  // names to decide whether the "Add an AI provider key" step was done. Adding
  // two providers did not touch it, so the founder pasted a real Hugging Face
  // key and the step stayed unticked: a checklist telling someone to do a thing
  // they had just done. Nothing failed. The guard written the same hour did not
  // catch it, because it was looking at the wrong two files.
  //
  // The fix was to DELETE that list (ask "is anything but Deepgram configured?"
  // instead). This test makes deletion the only option next time.

  const RENDERER = join(ROOT, 'src/renderer')

  /** The single legitimate enumeration: the key-entry cards, where each card is
   *  a real UI object that must name its own key. Anywhere else, a list of key
   *  names is a copy of main's list that nothing keeps in sync. */
  const ALLOWED = 'src/renderer/src/features/settings/ApiKeysSection.tsx'

  it('no renderer file except the key cards enumerates key names', () => {
    const offenders: string[] = []
    const files = readdirSync(RENDERER, { recursive: true, encoding: 'utf8' })
    for (const rel of files) {
      if (!/\.(ts|tsx)$/.test(rel)) continue
      const full = join(RENDERER, rel)
      if (!statSync(full).isFile()) continue
      const posix = ('src/renderer/' + rel).replace(/\\/g, '/')
      if (posix === ALLOWED) continue
      const names = new Set(
        [...stripComments(readFileSync(full, 'utf8')).matchAll(/'([A-Z][A-Z0-9_]*_API_KEY)'/g)].map(
          (m) => m[1]
        )
      )
      // One or two named keys is a specific reference (Deepgram gates
      // transcription, and that is a real distinction). Three or more is a list.
      if (names.size >= 3) offenders.push(`${posix} names ${[...names].sort().join(", ")}`)
    }
    expect(
      offenders,
      'these files enumerate the AI key list; derive it from aiKeys.getStatus() instead'
    ).toEqual([])
  })

  it('every key in main is reachable from the API keys page', () => {
    // The other direction: a provider wired all the way through main and preload
    // but with no card is a provider nobody can give a key to.
    //
    // Matches BOTH shapes a name can appear in — a card's own `name`, and a
    // `secondField.name` — because Cloudflare's account id is entered on the
    // Cloudflare card rather than getting a card of its own. The regex is
    // therefore anchored on "name:" alone, not on the _API_KEY suffix.
    const cards = stripComments(readFileSync(join(ROOT, ALLOWED), 'utf8'))
    const named = [...cards.matchAll(/name:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1])
    expect(sorted([...new Set(named)])).toEqual(sorted(MAIN_KEYS))
  })

  it('only the documented non-credential value lacks the _API_KEY suffix', () => {
    // ActivationChecklist decides "has the user added an AI provider?" from
    // this suffix, so the suffix is a contract, not a naming habit. Adding
    // another non-key value to the vault must force a decision about that
    // step rather than silently ticking it — this is the tripwire.
    const notKeys = MAIN_KEYS.filter((n) => !n.endsWith('_API_KEY'))
    expect(notKeys).toEqual(['CLOUDFLARE_ACCOUNT_ID'])
  })

  it('every provider needing extra credentials declares them', () => {
    // requiredEnvNames is what makes a half-configured provider count as
    // unconfigured everywhere. A name here that is not a real key would fail
    // open — the check would pass vacuously for a var nobody ever sets.
    const registry = stripComments(read('src/main/ai/registry.ts'))
    const required = [...registry.matchAll(/requiredEnvNames:\s*\[([^\]]*)\]/g)].flatMap((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    )
    // Written as a const reference in the registry, so resolve that too.
    const viaConst = registry.includes('requiredEnvNames: [CLOUDFLARE_ACCOUNT_ENV]')
    expect(viaConst || required.length > 0).toBe(true)
    for (const name of required) expect(MAIN_KEYS).toContain(name)
  })
})

describe('providerHasCredentials: half-configured is NOT configured', () => {
  // The behaviour the whole requiredEnvNames change exists for. Without this,
  // a Cloudflare key with no account id builds a base URL with a hole in it
  // and every call 404s against an address that looks almost right.
  const saved: Record<string, string | undefined> = {}
  const set = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('is false with a key but no account id', () => {
    set('CLOUDFLARE_API_KEY', 'test-token')
    set('CLOUDFLARE_ACCOUNT_ID', undefined)
    expect(providerHasCredentials('cloudflare')).toBe(false)
  })

  it('is false with an account id but no key', () => {
    set('CLOUDFLARE_API_KEY', undefined)
    set('CLOUDFLARE_ACCOUNT_ID', 'abc123')
    expect(providerHasCredentials('cloudflare')).toBe(false)
  })

  it('is true only with both', () => {
    set('CLOUDFLARE_API_KEY', 'test-token')
    set('CLOUDFLARE_ACCOUNT_ID', 'abc123')
    expect(providerHasCredentials('cloudflare')).toBe(true)
  })

  it('treats whitespace as absent, matching every other key check', () => {
    set('CLOUDFLARE_API_KEY', 'test-token')
    set('CLOUDFLARE_ACCOUNT_ID', '   ')
    expect(providerHasCredentials('cloudflare')).toBe(false)
  })

  it('a single-credential provider still needs only its key', () => {
    set('GROQ_API_KEY', 'test-token')
    expect(providerHasCredentials('groq')).toBe(true)
  })
})

describe('credential declaration is enforced by the compiler, not by hope', () => {
  it('requiredEnvNames is declared as required, not optional', () => {
    // The whole fix. While the field was OPTIONAL, a provider that forgot to
    // declare an extra credential was treated as needing none — considered
    // configured while its base URL still had a hole in it. That is how the
    // founder ended up on a broken provider. Required turns forgetting into a
    // build error.
    //
    // This asserts the TYPE, deliberately, because the runtime still carries a
    // nullish-coalescing shim for the seventeen test files that replace this
    // registry wholesale with partial fixtures. Re-adding the question mark
    // would silently restore the old behaviour AND leave that shim looking
    // like a safety net it is not.
    const registry = stripComments(read('src/main/ai/registry.ts'))
    expect(registry).toMatch(/requiredEnvNames:\s*readonly string\[\]/)
    expect(
      registry,
      'requiredEnvNames went back to optional - a provider can now forget it silently'
    ).not.toMatch(/requiredEnvNames\?:/)
  })

  it('every provider actually declares it', () => {
    const registry = stripComments(read('src/main/ai/registry.ts'))
    const providers = [...registry.matchAll(/keyEnvName:/g)].length
    const declared = [...registry.matchAll(/requiredEnvNames:/g)].length
    // Equal, not off-by-one: both counts include their own declaration on the
    // ProviderRegistryEntry interface, so the interface cancels out and what
    // is left is one requiredEnvNames per provider.
    expect(declared, 'a provider is missing its requiredEnvNames declaration').toBe(
      providers
    )
  })
})
