// BUG-143 (2026-08-30) — saving a key must not hand it the default provider
// unless it actually works.
//
// THE FIELD FAILURE, reconstructed from the founder's machine rather than
// guessed. Stored keys were exactly: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_KEY,
// DEEPGRAM_API_KEY, HUGGINGFACE_API_KEY — and `aiProvider`'s built-in default is
// `anthropic`, for which there is no key at all. So:
//
//   1. aiProvider = 'anthropic' (built-in default, NO key) -> getAIProvider null
//   2. save CLOUDFLARE_ACCOUNT_ID -> not any provider's keyEnvName, no selection
//   3. save CLOUDFLARE_API_KEY -> cloudflare now has both credentials, the
//      current provider resolves to nothing, so cloudflare is auto-selected —
//      A KEY CLOUDFLARE REJECTS BECOMES THE DEFAULT FOR EVERYTHING. This is
//      the hijack, and it is what put BUG-142's summaries on a dead provider.
//   4. save HUGGINGFACE_API_KEY -> getAIProvider('cloudflare') is NON-null,
//      because the key is PRESENT, so the guard returns early and the working
//      key cannot take over.
//   5. the founder changed the provider back to Hugging Face by hand.
//
// THE DEFECT IN ONE LINE. `maybeAutoSelectProvider`'s guard is
// `if (getAIProvider(current)) return`, and `getAIProvider` returns non-null
// whenever a key is PRESENT — it never asks whether the key works. The
// function's own doc comment claims it fires when "the selected provider has no
// working key". Presence is not working, and the gap between the comment and
// the code is the entire bug: a REJECTED key both wins the default and is then
// protected from being replaced by a good one.
//
// THE FIX PINNED HERE: auto-select only a key that VALIDATES. That alone breaks
// the sequence at step 3, so step 4 never arises.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}

let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: {
    handle: (name: string, fn: Handler) => {
      handlers[name] = fn
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

// Which keys the fake providers accept. Keyed by the KEY VALUE so a test can
// save a good key and a bad one to the same provider.
const rejected = new Set<string>()

vi.mock('../ai', () => {
  const entry = (keyEnvName: string): Record<string, unknown> => ({
    keyEnvName,
    requiredEnvNames: [],
    build: () => ({})
  })
  const PROVIDER_REGISTRY: Record<string, Record<string, unknown>> = {
    anthropic: entry('ANTHROPIC_API_KEY'),
    huggingface: entry('HUGGINGFACE_API_KEY'),
    cloudflare: entry('CLOUDFLARE_API_KEY')
  }
  return {
    PROVIDER_REGISTRY,
    // Mirrors the real one: NON-NULL whenever the key is merely PRESENT. The
    // bug lives in trusting this as "works", so the mock must reproduce that
    // faithfully rather than being helpfully stricter.
    getAIProvider: (id: string) => {
      const e = PROVIDER_REGISTRY[id]
      if (!e) return null
      return process.env[e.keyEnvName as string]?.trim() ? {} : null
    },
    buildProviderForValidation: (_id: string, key: string) => ({
      validateKey: async () =>
        rejected.has(key)
          ? { ok: false as const, reason: 'Your key was rejected.' }
          : { ok: true as const, models: ['m'] }
    })
  }
})

const { registerAiKeys } = await import('../ai-keys')
const { loadAppSettings } = await import('../app-settings')

registerAiKeys()

const ALL = ['ANTHROPIC_API_KEY', 'HUGGINGFACE_API_KEY', 'CLOUDFLARE_API_KEY']

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'callrise-bug143-'))
  rejected.clear()
  for (const n of ALL) delete process.env[n]
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('BUG-143 — a rejected key must not become the default provider', () => {
  it('THE FIELD CASE: a key the provider rejects does NOT get made the default', async () => {
    // Step 1: the built-in default, with no key for it.
    expect(loadAppSettings().aiProvider).toBe('anthropic')

    rejected.add('a-token-cloudflare-rejects')
    const res = await handlers['aiKeys:save'](
      null,
      'CLOUDFLARE_API_KEY',
      'a-token-cloudflare-rejects'
    )

    // The save itself still succeeds — the user may be offline, or saving it
    // to fix later. Refusing to STORE it would be a different, worse product.
    expect((res as { ok: boolean }).ok).toBe(true)
    // But it must not have taken over everything.
    expect(loadAppSettings().aiProvider).toBe('anthropic')
  })

  it('a key that DOES validate still becomes the default — the useful behaviour is intact', async () => {
    // This is the behaviour BUG-020's auto-select exists for, and the fix must
    // not cost it: a first working key still saves the user a Settings trip.
    const res = await handlers['aiKeys:save'](null, 'HUGGINGFACE_API_KEY', 'a-working-key')
    expect((res as { ok: boolean }).ok).toBe(true)
    expect(loadAppSettings().aiProvider).toBe('huggingface')
  })

  it('reports what it did, so the change is never silent', async () => {
    // The founder's standing point, and it holds whichever guard shape is
    // chosen: an automatic change to a user-visible setting that is never
    // announced is the same species as M31 Stage 4's visibility rule.
    const good = (await handlers['aiKeys:save'](
      null,
      'HUGGINGFACE_API_KEY',
      'a-working-key'
    )) as Record<string, unknown>
    expect(good.autoSelectedProvider).toBe('huggingface')
  })

  it('reports a DECLINED switch distinctly from having nothing to do', async () => {
    // Deliberately from a clean state with no working provider, because that
    // is the only path on which validation is attempted at all. The first
    // draft of this test saved a good key FIRST and then a bad one, and
    // expected `keyValidated: false` — but the good key made the provider
    // work, so the "already working" early return fired and nothing was ever
    // validated. `undefined` was the correct answer; the assertion was wrong.
    // Worth keeping as a comment: the two "no switch happened" cases are not
    // the same event, and a test that conflates them cannot check either.
    rejected.add('bad')
    const bad = (await handlers['aiKeys:save'](null, 'CLOUDFLARE_API_KEY', 'bad')) as Record<
      string,
      unknown
    >
    expect(bad.autoSelectedProvider).toBeUndefined()
    expect(bad.keyValidated).toBe(false) // we tried, and it failed

    // And the other shape: a save that never needed to switch reports neither
    // field, so a caller can tell "declined" from "nothing to do".
    await handlers['aiKeys:save'](null, 'HUGGINGFACE_API_KEY', 'a-working-key')
    const noop = (await handlers['aiKeys:save'](
      null,
      'CLOUDFLARE_API_KEY',
      'another-working-key'
    )) as Record<string, unknown>
    expect(noop.autoSelectedProvider).toBeUndefined()
    expect(noop.keyValidated).toBeUndefined()
  })

  it('still never overrides a provider that is already working', async () => {
    // The original guard's good half, unchanged: adding a backup key to an
    // install that already works must not silently move the default.
    await handlers['aiKeys:save'](null, 'HUGGINGFACE_API_KEY', 'a-working-key')
    expect(loadAppSettings().aiProvider).toBe('huggingface')

    await handlers['aiKeys:save'](null, 'CLOUDFLARE_API_KEY', 'another-working-key')
    expect(loadAppSettings().aiProvider).toBe('huggingface')
  })
})
