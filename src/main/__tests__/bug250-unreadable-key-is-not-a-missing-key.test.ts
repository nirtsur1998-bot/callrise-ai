// BUG-250 — a key that cannot be DECRYPTED was reported as a key that was
// never entered, so the app told the user to add keys they already have.
//
// `loadKey` returned `null` for both, with a comment that knew the difference
// and discarded it: *"Missing file, or decrypt failed (keychain reset / moved
// machine) → treat as not-configured; the user just re-enters it in
// Settings."* They never do, because nothing tells them to. Every surface said
// "No key", Home said "Live transcription needs a Deepgram key", and the live
// screen offered to help them get one free in a minute — while the key sat on
// disk in a file the app could see and could not read.
//
// Found by copying `ai-keys/*.enc` into a sandbox WITHOUT `Local State`.
// Electron's safeStorage on Windows does not DPAPI-protect each value:
// Chromium's OSCrypt keeps a per-profile random key in `Local State` and
// protects that. All nine keys reported `configured: false`, silently.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
/** Flipped per test: true = safeStorage can decrypt, false = it cannot. */
let canDecrypt = true

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      if (!canDecrypt) throw new Error('decrypt failed (OSCrypt key changed)')
      const s = b.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('not our ciphertext')
      return s.slice(4)
    }
  }
}))
vi.mock('../ai', () => ({
  PROVIDER_REGISTRY: {},
  buildProviderForValidation: vi.fn(),
  getAIProvider: vi.fn()
}))
vi.mock('../app-settings', () => ({
  loadAppSettings: () => ({}),
  saveAppSettings: vi.fn()
}))
vi.mock('../deepgram-key', () => ({ validateDeepgramKey: vi.fn() }))
vi.mock('../ai/provider-demotion', () => ({ clearDemotion: vi.fn(), demotionState: () => null }))

// ONE module instance for both functions, deliberately. The first draft of
// this file imported `registerAiKeys` freshly inside the helper below, which
// handed it a SEPARATE copy of the module with an empty unreadable-key set -
// so the status was read from a different instance than the one the load had
// populated, and the test failed for a reason that had nothing to do with the
// code. Same family as species 93: the check and the thing checked were not
// the same object.
const { loadStoredAiKeysIntoEnv, registerAiKeys, AI_KEY_NAMES } = await import('../ai-keys')
const { ipcMain } = await import('electron')

/** The only way to observe the distinction from outside: env is populated for a
 *  readable key and not for an unreadable one — and the STATUS says which. */
async function statusFor(): Promise<Record<string, { configured: boolean; unreadable?: boolean }>> {
  const handlers = new Map<string, () => Promise<unknown>>()
  ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (channel: string, fn: () => Promise<unknown>) => handlers.set(channel, fn)
  )
  registerAiKeys()
  return (await handlers.get('aiKeys:getStatus')!()) as Record<
    string,
    { configured: boolean; unreadable?: boolean }
  >
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bug250-'))
  mkdirSync(join(dir, 'ai-keys'))
  canDecrypt = true
  for (const n of AI_KEY_NAMES) delete process.env[n]
})
afterEach(() => {
  for (const n of AI_KEY_NAMES) delete process.env[n]
  rmSync(dir, { recursive: true, force: true })
})

const writeKey = (name: string, value: string): void =>
  writeFileSync(join(dir, 'ai-keys', `${name}.enc`), Buffer.from(`enc:${value}`))

describe('BUG-250 — "cannot decrypt" and "never entered" are different answers', () => {
  it('loads a readable key and reports it configured', async () => {
    writeKey('DEEPGRAM_API_KEY', 'dg-real')
    await loadStoredAiKeysIntoEnv()
    expect(process.env.DEEPGRAM_API_KEY).toBe('dg-real')
    const status = await statusFor()
    expect(status.DEEPGRAM_API_KEY.configured).toBe(true)
    expect(status.DEEPGRAM_API_KEY.unreadable).toBeUndefined()
  })

  it('reports UNREADABLE when the file exists and will not decrypt', async () => {
    // The load-bearing one. Before the fix this was indistinguishable from
    // having never entered a key, and every surface said so.
    writeKey('DEEPGRAM_API_KEY', 'dg-real')
    canDecrypt = false
    await loadStoredAiKeysIntoEnv()
    const status = await statusFor()
    expect(status.DEEPGRAM_API_KEY.configured).toBe(false)
    expect(
      status.DEEPGRAM_API_KEY.unreadable,
      'a key on disk that will not decrypt must not read as "no key"'
    ).toBe(true)
  })

  it('does NOT claim unreadable when there is simply no file', async () => {
    // The control, and the one that stops the fix over-claiming: a genuine
    // new install has no file, and telling that user their key is unreadable
    // would be the same defect pointing the other way.
    canDecrypt = false
    await loadStoredAiKeysIntoEnv()
    const status = await statusFor()
    expect(status.DEEPGRAM_API_KEY.configured).toBe(false)
    expect(status.DEEPGRAM_API_KEY.unreadable).toBeUndefined()
  })

  it('NEVER deletes the unreadable file', async () => {
    // A standing instruction, pinned. It may decrypt tomorrow — a profile
    // mounted from the wrong account, a restored Local State — and it is the
    // only copy of something the user typed.
    writeKey('DEEPGRAM_API_KEY', 'dg-real')
    canDecrypt = false
    await loadStoredAiKeysIntoEnv()
    await statusFor()
    expect(
      existsSync(join(dir, 'ai-keys', 'DEEPGRAM_API_KEY.enc')),
      'the unreadable key file was removed — it is the only copy the user has'
    ).toBe(true)
  })
})
