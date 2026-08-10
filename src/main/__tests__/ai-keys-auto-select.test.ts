// Founder-reported bug: "Ask the coach" (and custom trackers) read a single
// "Default text AI provider" setting directly, which was hardcoded to only
// ever be Claude or ChatGPT in the Settings UI — so a user who configured a
// different provider (Groq, Gemini, ...) saw those features fail with "add
// your Claude or ChatGPT key" despite having a working key. This proves the
// new auto-select behavior: saving a text-AI key switches the default
// provider to it automatically UNLESS the current selection already has a
// working key (never surprises an existing Claude/OpenAI install).
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

const { registerAiKeys } = await import('../ai-keys')
const { loadAppSettings } = await import('../app-settings')

registerAiKeys()

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'callrise-ai-keys-'))
  for (const name of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
    'GOOGLE_AI_API_KEY',
    'MISTRAL_API_KEY'
  ]) {
    delete process.env[name]
  }
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('aiKeys:save auto-selects the default provider', () => {
  it('switches the default provider to the first key ever saved (fresh install)', async () => {
    expect(loadAppSettings().aiProvider).toBe('anthropic') // the built-in default, no key for it yet

    await handlers['aiKeys:save'](null, 'GROQ_API_KEY', 'gsk_test_key_value')

    expect(loadAppSettings().aiProvider).toBe('groq')
  })

  it('does NOT override an already-working provider when a second key is added', async () => {
    await handlers['aiKeys:save'](null, 'ANTHROPIC_API_KEY', 'sk-ant-test-key-value')
    expect(loadAppSettings().aiProvider).toBe('anthropic')

    // Adding a backup/second provider must not silently switch an install
    // that already has a working default.
    await handlers['aiKeys:save'](null, 'GROQ_API_KEY', 'gsk_test_key_value')
    expect(loadAppSettings().aiProvider).toBe('anthropic')
  })

  it('does switch if the current default provider\'s key is later cleared/never worked, and a different one is saved', async () => {
    // Current default is 'anthropic' (built-in default) but no Anthropic key
    // has ever been configured — saving Gemini's key should adopt it.
    await handlers['aiKeys:save'](null, 'GOOGLE_AI_API_KEY', 'test-gemini-key')
    expect(loadAppSettings().aiProvider).toBe('google')
  })

  it('does not touch the provider selection when saving the Deepgram key (not a text-AI provider)', async () => {
    await handlers['aiKeys:save'](null, 'DEEPGRAM_API_KEY', 'dg-test-key')
    expect(loadAppSettings().aiProvider).toBe('anthropic') // unchanged built-in default
  })

  it('rejects an invalid key name without touching provider selection', async () => {
    const result = await handlers['aiKeys:save'](null, 'NOT_A_REAL_KEY', 'value')
    expect(result).toEqual({ ok: false, error: 'invalid-input' })
    expect(loadAppSettings().aiProvider).toBe('anthropic')
  })
})
