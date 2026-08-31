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
import type { AIValidateKeyResult } from './ai/types'
import { loadAppSettings, saveAppSettings } from './app-settings'
import { validateDeepgramKey } from './deepgram-key'
import { clearDemotion, demotionState } from './ai/provider-demotion'

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
 * ⚠ THE PARAGRAPH THAT USED TO SIT HERE WAS TRUE FOR ABOUT AN HOUR, AND THEN
 * DESCRIBED SOMETHING THE CODE NO LONGER DID. It said the validation "runs
 * after the 'already working' early return, so an install with a working
 * provider never pays for it" — which was the bug the founder then found by
 * hand: with a working default, NOTHING was validated, and the card showed a
 * green "Connected" dot for the string `junk`.
 *
 * Left as a marker rather than deleted, because this file has now produced the
 * same failure twice: a comment describing the intent while the code does
 * something narrower, and nobody re-reading the comment when the code moved.
 * The first instance is the paragraph above ("no working key" vs. presence).
 * **When you change this function, change this comment in the same edit.**
 *
 * The current behaviour is in `probeKey` below, which
 * `validateAndMaybeAutoSelect` calls as its FIRST statement: every text-AI
 * key save validates, always, and the round trip is paid on every such save.
 *
 * BUG-146 widened that beyond text AI without weakening it: `DEEPGRAM_API_KEY`
 * is probed too, by its own checker, because "has a provider id" was never the
 * right question — "can anything check this credential?" is. The one credential
 * still outside it is `CLOUDFLARE_ACCOUNT_ID`, which reports "Not checked"
 * rather than claiming health it has not got.
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
export interface SaveKeyOutcome {
  /** Set only when the default provider was actually changed. */
  autoSelectedProvider?: AIProviderId
  /** Was this credential shown to work, just now? Present for every key that
   *  something can check — every text-AI key, and (BUG-146) DEEPGRAM_API_KEY.
   *  `undefined` means NOTHING could check it, which today is only
   *  CLOUDFLARE_ACCOUNT_ID, and is displayed as "Not checked" rather than
   *  being rounded up to good or down to bad. */
  keyValidated?: boolean
  /** The provider's own words when it did not. Displayed verbatim. */
  validationReason?: string
}

/**
 * BUG-143 follow-up (2026-08-30) — VALIDATION IS NO LONGER PART OF THE
 * AUTO-SELECT PATH. It is the whole point of the save.
 *
 * THE HOLE, found by the founder doing the ten-second check I had automated
 * badly. The first version validated INSIDE the auto-select function, after its
 * `if (getAIProvider(current)) return {}` early return. So on the ordinary case
 * — you already have a working default, you paste another key — nothing was
 * validated at all. The founder typed `junk` into the OpenAI card and the card
 * answered with a green dot reading **"Connected"**, a green tick reading
 * **"Configured"**, and **"Saved — takes effect immediately."** All three false.
 *
 * That is the SAME presence-vs-works confusion this bug is about, one layer up:
 * `deriveStatusDot` (ApiKeysSection.tsx) reads `status.configured`, which is
 * `Boolean(process.env[name])`. The first fix corrected the SELECTION logic and
 * left the DISPLAY lying — on the screen where being wrong costs the most,
 * because someone who sees "Connected" stops looking for the problem. That is
 * exactly how the founder ended up on a broken Cloudflare provider.
 *
 * So: every text-AI key save now validates, and the result is reported whether
 * or not a switch was ever on offer. Auto-selection becomes one thing the
 * outcome can also say, rather than the only path that computes it.
 *
 * COST: a network round-trip on every text-AI key save. Accepted — the user has
 * just pasted a key and is waiting on that screen, and "Test key" already does
 * exactly this round-trip on demand. The alternative is a status indicator that
 * cannot tell a working key from a typo.
 *
 * ── BUG-146 (2026-08-31): DEEPGRAM IS NOW COVERED TOO ───────────────
 *
 * The note that stood here said Deepgram and CLOUDFLARE_ACCOUNT_ID were both
 * unvalidated because neither resolves to a providerId. That was true, and for
 * Deepgram it was the worst possible place to be true: it is what live
 * transcription runs on, so its failure surfaces MID-CALL.
 *
 * Validation is therefore no longer keyed on "is this a text-AI provider".
 * `probeKey` below answers "can anything check this credential?" — a different
 * question, with a different answer for Deepgram (see deepgram-key.ts).
 * Auto-selection stays keyed on the provider id, because promoting Deepgram to
 * "default text AI provider" would be nonsense.
 *
 * STILL NOT COVERED: `CLOUDFLARE_ACCOUNT_ID` (BUG-147). It is not a key and has
 * no probe of its own, so `probeKey` returns null for it and its card reports
 * "Not checked" rather than claiming anything. Recorded, not quietly left.
 */
/**
 * BUG-146 — "can anything check this credential?", which is deliberately NOT
 * the same question as "is this a text-AI provider?". Deepgram answers yes to
 * the first and no to the second, and conflating the two is exactly why the
 * app's most consequential key went unchecked from M16 until now.
 *
 * null means NOTHING can check it (CLOUDFLARE_ACCOUNT_ID) — distinct from
 * { ok: false }, which means something checked it and it failed. Callers must
 * keep those apart: one is "we do not know", the other is "we know it is bad".
 *
 * Exported for its own test.
 */
/**
 * What the renderer's "Test key" button names when it asks for a check.
 *
 * A text-AI provider is named by its own id. Deepgram is named by the literal
 * below because it is deliberately NOT in PROVIDER_REGISTRY — the registry
 * feeds the "default text AI provider" picker, and Deepgram cannot complete a
 * text request. Giving it a provider id to make validation work would have put
 * it in that picker; this keeps the two concerns apart.
 *
 * Pinned by a test asserting this string is NOT a provider id, because the day
 * it becomes one this union silently stops discriminating.
 */
export const DEEPGRAM_TARGET = 'deepgram'
export type AiValidateTarget = AIProviderId | typeof DEEPGRAM_TARGET

/** Target -> the key it names. The ONE place that mapping exists.
 *
 *  Resolved THROUGH `KEY_NAMES` rather than cast: `keyEnvName` is typed
 *  `string`, so a registry entry naming a key this module does not know would
 *  otherwise sail through as a valid AiKeyName and reach probeKey. Returning
 *  null for it is the refuse-don't-guess shape (species 53) and costs a lookup
 *  over a 13-element array. */
function keyNameForTarget(target: AiValidateTarget): AiKeyName | null {
  if (target === DEEPGRAM_TARGET) return 'DEEPGRAM_API_KEY'
  const envName = PROVIDER_REGISTRY[target as AIProviderId]?.keyEnvName
  return KEY_NAMES.find((n) => n === envName) ?? null
}

export async function probeKey(
  name: AiKeyName,
  value: string
): Promise<AIValidateKeyResult | null> {
  if (name === 'DEEPGRAM_API_KEY') return validateDeepgramKey(value)

  const providerId = providerIdForKeyName(name)
  if (!providerId) return null

  try {
    const probe = buildProviderForValidation(providerId, value)
    return await probe.validateKey(value)
  } catch {
    // A thrown probe is indistinguishable here from a rejected one, and both
    // answer the only question being asked: has this key been shown to work?
    return { ok: false, reason: 'Could not reach this provider to check the key.' }
  }
}

async function validateAndMaybeAutoSelect(
  name: AiKeyName,
  value: string
): Promise<SaveKeyOutcome> {
  const probe = await probeKey(name, value)
  // Nothing can check this credential. Report NOTHING rather than a cheerful
  // default: `keyValidated` stays undefined, which the card renders as "Not
  // checked". An UNCHECKABLE credential and a verified-good one must not
  // produce the same screen.
  if (!probe) return {}

  const keyValidated = probe.ok
  const validationReason = probe.ok ? undefined : probe.reason
  const providerId = providerIdForKeyName(name)

  // BUG-148 — a key that just proved it works cancels any demotion against
  // its provider immediately. Without this, the fix would punish exactly the
  // person doing the right thing: you paste the corrected key, the card goes
  // green, and the chain still refuses to lead with it until a background job
  // happens to succeed on it or four hours elapse.
  //
  // Deliberately keyed on the VALIDATED result, not on the save. A save alone
  // is what BUG-143 was about — presence is not health, and a demotion cleared
  // by presence would be cleared by pasting the same rejected key again.
  if (providerId && keyValidated) clearDemotion(providerId)

  // Auto-selection is now conditional on BOTH: nothing usable is selected, and
  // the key we would switch to actually works.
  const current = loadAppSettings().aiProvider
  // `providerId &&` is new with BUG-146: DEEPGRAM_API_KEY now validates, and a
  // validated Deepgram key must never be promoted to "default text AI
  // provider" — it cannot complete a single text request.
  if (providerId && keyValidated && !getAIProvider(current)) {
    saveAppSettings({ aiProvider: providerId })
    return { autoSelectedProvider: providerId, keyValidated: true }
  }
  return keyValidated ? { keyValidated: true } : { keyValidated: false, validationReason }
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
    ) as Record<
      AiKeyName,
      { configured: boolean; hint: string | null; demotedSince?: number }
    >
    const now = Date.now()
    for (const name of KEY_NAMES) {
      status[name].configured = isConfigured(name)
      const raw = process.env[name]
      if (raw) status[name].hint = maskedHint(raw)
      // BUG-148 — "visibly, never silently" (founder, 2026-08-31). A demotion
      // reorders attempts behind the user's back unless something says so, and
      // an automatic change to user-visible behaviour that is never announced
      // is taxonomy species 44. Carried on the status the card already fetches
      // rather than a new channel, so it cannot go stale relative to the rest
      // of the card.
      const providerId = providerIdForKeyName(name)
      if (providerId) {
        const demotion = demotionState(providerId, now)
        if (demotion?.demoted) status[name].demotedSince = demotion.demotedAt ?? undefined
      }
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
    const outcome = await validateAndMaybeAutoSelect(name as AiKeyName, value.trim())
    return { ok: true as const, ...outcome }
  })

  // "Test key" - the cheapest possible round-trip against a key the user
  // just pasted (not necessarily saved yet), so a bad key is caught before
  // it's relied on mid-call. Every text-AI provider in PROVIDER_REGISTRY
  // (M20: 8, up from the original anthropic/openai pair) has this; Deepgram
  // has no equivalent flow here (transcription, not text AI).
  ipcMain.handle('aiKeys:validate', async (_event, target: unknown, value: unknown) => {
    if (typeof target !== 'string' || typeof value !== 'string' || !value.trim()) {
      return { ok: false as const, reason: 'Enter a key first.' }
    }
    const name =
      target === DEEPGRAM_TARGET || target in PROVIDER_REGISTRY
        ? keyNameForTarget(target as AiValidateTarget)
        : null
    if (!name) return { ok: false as const, reason: 'Enter a key first.' }

    // BUG-146 — delegated to probeKey rather than re-probing here. "Test key"
    // and the save path answered the same question through two code paths
    // before, which is how Groq's dead testModel (BUG-081) made "Test key"
    // reject keys the save path was happy with. One mechanism, one answer.
    const result = await probeKey(name, value.trim())
    // Unreachable from the UI: a card with nothing to check renders no Test
    // button. Worded so that even if it were reached it does not accuse the
    // value of being wrong — not knowing is not the same as knowing it is bad.
    return result ?? { ok: false as const, reason: 'This value has no automatic check.' }
  })

  ipcMain.handle('aiKeys:clear', async (_event, name: unknown) => {
    if (!KEY_NAMES.includes(name as AiKeyName))
      return { ok: false as const, error: 'invalid-input' }
    await clearKey(name as AiKeyName)
    delete process.env[name as AiKeyName]
    return { ok: true as const }
  })
}
