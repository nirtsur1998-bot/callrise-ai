// Lets a user bring their own Deepgram (transcription) and Anthropic
// (coaching/summaries) API keys from Settings, instead of the app shipping
// with — and billing — a single key for every customer. Each key is stored
// ENCRYPTED via Electron safeStorage (macOS Keychain / Windows DPAPI), same
// pattern as the Google refresh token in google.ts.
//
// On startup, any stored key is loaded into process.env — every existing
// consumer (transcription.ts, coach.ts, summarize.ts, etc.) already just
// reads process.env.DEEPGRAM_API_KEY / ANTHROPIC_API_KEY, so nothing else
// needs to change. A key entered mid-session takes effect after the app is
// restarted (those consumers cache their client on first use).
import { app, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { buildProviderForValidation, getAIProvider, PROVIDER_REGISTRY, type AIProviderId } from './ai'
import { loadAppSettings, saveAppSettings } from './app-settings'

// M20 added the six new text-AI provider keys (GROQ_API_KEY through
// MISTRAL_API_KEY) alongside M16's original ANTHROPIC_API_KEY/OPENAI_API_KEY
// pair. Everything below this point (encryption, save/load/clear, IPC) was
// already generic over AiKeyName — extending it needed no new mechanism,
// exactly per docs/ai-providers.md's "Adding a third provider" guide.
// ONE list, type derived from it — same reasoning as ai/types.ts's
// AI_PROVIDER_IDS. KEY_NAMES used to be a second hand-maintained copy of the
// union, and it is the list getStatus() iterates: a key present in the type
// but missing from the array saves correctly, decrypts correctly, and then
// reports "No key" forever, because nothing ever sets its configured flag.
// Silent, and indistinguishable from the user having pasted a bad key.
export const AI_KEY_NAMES = [
  'DEEPGRAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_AI_API_KEY',
  'NVIDIA_API_KEY',
  'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY',
  'ZAI_API_KEY',
  'HUGGINGFACE_API_KEY',
  'CLOUDFLARE_API_KEY',
  // NOT a key, and the only entry here that is not one. Cloudflare's base URL
  // contains the account id, so an API key alone cannot address the account —
  // both values are required before a call can be made at all. It lives in
  // this vault to reuse one save/clear/status/env pipeline rather than invent
  // a second one, and the '_API_KEY' suffix is what tells the rest of the app
  // it is a credential, not a key (see ActivationChecklist and the lockstep
  // test that pins this exception).
  'CLOUDFLARE_ACCOUNT_ID'
] as const

export type AiKeyName = (typeof AI_KEY_NAMES)[number]
const KEY_NAMES: readonly AiKeyName[] = AI_KEY_NAMES

function keysDir(): string {
  return join(app.getPath('userData'), 'ai-keys')
}
function keyPath(name: AiKeyName): string {
  return join(keysDir(), `${name}.enc`)
}

async function saveKey(name: AiKeyName, value: string): Promise<void> {
  await fs.mkdir(keysDir(), { recursive: true })
  // 0600: owner-only, defense-in-depth on top of the encryption.
  await fs.writeFile(keyPath(name), safeStorage.encryptString(value), { mode: 0o600 })
}

async function loadKey(name: AiKeyName): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const value = safeStorage.decryptString(await fs.readFile(keyPath(name)))
    return value || null
  } catch {
    // Missing file, or decrypt failed (keychain reset / moved machine) → treat
    // as not-configured; the user just re-enters it in Settings.
    return null
  }
}

async function clearKey(name: AiKeyName): Promise<void> {
  await fs.unlink(keyPath(name)).catch(() => {})
}

function providerIdForKeyName(name: AiKeyName): AIProviderId | null {
  for (const id of Object.keys(PROVIDER_REGISTRY) as AIProviderId[]) {
    if (PROVIDER_REGISTRY[id].keyEnvName === name) return id
  }
  return null // DEEPGRAM_API_KEY — not a text-AI provider, nothing to select
}

/**
 * BUG found by the founder using the app: "Ask the coach" and a few other
 * features read the single "Default text AI provider" setting directly
 * (unlike live coaching cues, which fall back across every configured
 * provider) — with the picker previously hardcoded to Claude/ChatGPT only,
 * anyone who configured a different provider saw those features fail with
 * "add your Claude or ChatGPT key" despite having a perfectly good key.
 *
 * This closes the gap for the smooth/default case: if the currently
 * selected provider has no working key, saving a new text-AI key switches
 * the default to it automatically, so those features work immediately with
 * no manual Settings trip. Never overrides an ALREADY-working selection —
 * adding a second/backup key to an install that already has Claude or
 * OpenAI configured changes nothing here. Settings' provider picker (now
 * showing all 8) and the Model Assignment page remain there for anyone who
 * wants to choose explicitly instead.
 *
 * ── BUG-143 (2026-08-30): IT MUST ALSO WORK ──────────────────────────────
 *
 * The paragraph above says this fires when "the currently selected provider
 * has no working key". The code only ever checked that a key was PRESENT —
 * `getAIProvider` returns non-null for any key that exists, working or not —
 * and it selected the new provider on the basis that a key had been SAVED,
 * never that it functioned. **Presence is not working, and the gap between
 * this comment and the code was the whole bug.**
 *
 * What that cost, reconstructed from the founder's own machine (stored keys
 * were exactly Cloudflare's pair, Deepgram, and Hugging Face — with the
 * built-in default `anthropic` holding no key at all):
 *
 *   1. aiProvider = 'anthropic', no key -> getAIProvider null
 *   2. save CLOUDFLARE_API_KEY -> cloudflare has both credentials, so a token
 *      Cloudflare REJECTS becomes the default for every feature. Post-call
 *      summaries then failed on a dead provider (BUG-142).
 *   3. save HUGGINGFACE_API_KEY -> getAIProvider('cloudflare') is NON-null,
 *      because the rejected key is still PRESENT, so this returns early and
 *      **the working key cannot take over.** The founder had to repoint the
 *      provider by hand.
 *
 * So a rejected key both won the default and was then protected from being
 * replaced by a good one. Validating before selecting breaks the sequence at
 * step 2, so step 3 never arises.
 *
 * THE VALIDATION COSTS A ROUND TRIP, and only on the path that was about to
 * change a setting anyway — it runs after the "already working" early return,
 * so an install with a working provider never pays for it.
 *
 * WHEN VALIDATION FAILS THE KEY IS STILL SAVED. Refusing to store it would be
 * a different and worse product: the user may be offline, or saving a key to
 * finish setting up later. What is withheld is only the automatic promotion to
 * default — and the outcome is REPORTED to the caller rather than left silent,
 * because an automatic change to a user-visible setting that is never
 * announced is the same species as M31 Stage 4's visibility rule. That
 * reporting also covers the offline case honestly: "saved, but we could not
 * verify it" is recoverable; a silent switch to a dead provider is not.
 */
export interface AutoSelectOutcome {
  /** Set only when the default provider was actually changed. */
  autoSelectedProvider?: AIProviderId
  /** Present whenever validation was attempted at all. */
  keyValidated?: boolean
}

async function maybeAutoSelectProvider(
  name: AiKeyName,
  value: string
): Promise<AutoSelectOutcome> {
  const providerId = providerIdForKeyName(name)
  if (!providerId) return {}
  const current = loadAppSettings().aiProvider
  if (getAIProvider(current)) return {}

  let keyValidated = false
  try {
    const probe = buildProviderForValidation(providerId, value)
    keyValidated = (await probe.validateKey(value)).ok
  } catch {
    // A thrown probe is indistinguishable here from a rejected one, and both
    // answer the only question being asked: has this key been shown to work?
    keyValidated = false
  }
  if (!keyValidated) return { keyValidated: false }

  saveAppSettings({ aiProvider: providerId })
  return { autoSelectedProvider: providerId, keyValidated: true }
}

/** BUG-022 — wipe every stored key (not just the encrypted file: also the
 *  in-memory env var, so a key cleared mid-session stops working immediately
 *  rather than surviving until restart like a normal Settings edit does). */
export async function clearAllAiKeys(): Promise<void> {
  for (const name of KEY_NAMES) {
    await clearKey(name)
    delete process.env[name]
  }
}

/** Populate process.env from any stored keys — call once at startup, before
 *  any AI-consuming module runs. A .env value (dev) always wins. */
export async function loadStoredAiKeysIntoEnv(): Promise<void> {
  for (const name of KEY_NAMES) {
    if (process.env[name]) continue
    const value = await loadKey(name)
    if (value) process.env[name] = value
  }
}

/** True once real API calls will succeed for this key — env var (.env or a
 *  baked-in default) or a stored Settings key, either way. */
function isConfigured(name: AiKeyName): boolean {
  return Boolean(process.env[name]?.trim())
}

/** A masked hint for display only ("sk-ant-…UD2I") — never the raw key. */
function maskedHint(value: string): string {
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/** "Your key was rejected" follow-up, pointing at wherever the key actually
 *  comes from — Settings for an installed app, .env for a developer. */
export function keyRejectedHint(name: AiKeyName): string {
  return app.isPackaged ? 'Check it in Settings → API keys.' : `Check ${name} in your .env file.`
}

export function registerAiKeys(): void {
  ipcMain.handle('aiKeys:getStatus', async () => {
    // Built FROM the list rather than restating it — this was the third copy
    // of these strings, and the one a new key would silently be missing from.
    const status = Object.fromEntries(
      AI_KEY_NAMES.map((n) => [n, { configured: false, hint: null }])
    ) as Record<AiKeyName, { configured: boolean; hint: string | null }>
    for (const name of KEY_NAMES) {
      status[name].configured = isConfigured(name)
      const raw = process.env[name]
      if (raw) status[name].hint = maskedHint(raw)
    }
    return status
  })

  ipcMain.handle('aiKeys:save', async (_event, name: unknown, value: unknown) => {
    if (!KEY_NAMES.includes(name as AiKeyName) || typeof value !== 'string' || !value.trim()) {
      return { ok: false as const, error: 'invalid-input' }
    }
    await saveKey(name as AiKeyName, value.trim())
    process.env[name as AiKeyName] = value.trim()
    // BUG-143 — awaited, and its outcome returned rather than discarded. This
    // used to be fire-and-forget on a synchronous function; the caller could
    // not tell whether its default provider had just been changed underneath
    // it, which is exactly what made the change silent.
    const outcome = await maybeAutoSelectProvider(name as AiKeyName, value.trim())
    return { ok: true as const, ...outcome }
  })

  // "Test key" - the cheapest possible round-trip against a key the user
  // just pasted (not necessarily saved yet), so a bad key is caught before
  // it's relied on mid-call. Every text-AI provider in PROVIDER_REGISTRY
  // (M20: 8, up from the original anthropic/openai pair) has this; Deepgram
  // has no equivalent flow here (transcription, not text AI).
  ipcMain.handle('aiKeys:validate', async (_event, providerId: unknown, value: unknown) => {
    if (
      typeof providerId !== 'string' ||
      !(providerId in PROVIDER_REGISTRY) ||
      typeof value !== 'string' ||
      !value.trim()
    ) {
      return { ok: false as const, reason: 'Enter a key first.' }
    }
    try {
      const provider = buildProviderForValidation(providerId as AIProviderId, value.trim())
      return await provider.validateKey(value.trim())
    } catch {
      return { ok: false as const, reason: 'Could not validate the key. Please try again.' }
    }
  })

  ipcMain.handle('aiKeys:clear', async (_event, name: unknown) => {
    if (!KEY_NAMES.includes(name as AiKeyName))
      return { ok: false as const, error: 'invalid-input' }
    await clearKey(name as AiKeyName)
    delete process.env[name as AiKeyName]
    return { ok: true as const }
  })
}
