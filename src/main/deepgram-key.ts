// BUG-146 — Deepgram is the one credential the app never checked.
//
// Every text-AI provider has had a `validateKey` round-trip since M16, wired
// into both "Test key" and (since BUG-143) the save path. Deepgram had
// neither, for a structural reason: it is not a text-AI provider, so it has no
// entry in PROVIDER_REGISTRY, so `providerIdForKeyName` returns null for it and
// every mechanism keyed on a provider id skips straight past it.
//
// The consequence is the worst-placed one in the app. Deepgram powers LIVE
// TRANSCRIPTION — the thing this product does. A wrong text-AI key degrades a
// summary you can regenerate; a wrong Deepgram key is discovered MID-CALL, by
// someone who had been shown a saved key and therefore stopped looking.
//
// WHY THIS ENDPOINT. `GET /v1/auth/token` is Deepgram's own documented
// "is my key valid" check (Authenticating guide: it "will return an invalid
// credentials error if your key is invalid, and a JSON response with details
// about your key if it's valid"). It describes the token used to make the
// request, so — unlike `/v1/projects` — it needs no project-read scope, and a
// key scoped only for transcription still answers it. That matters: a
// validator that rejects a WORKING key is worse than none, because it sends
// someone to regenerate a credential that was fine.
//
// WHAT A PASS PROVES, AND WHAT IT DOES NOT. It proves Deepgram accepts this
// credential right now. It does NOT prove the project has credit left, and it
// does not open a streaming socket. A funded-yesterday, empty-today project
// still fails mid-call and this check still says the key is good — that is a
// different failure with a different fix, and claiming otherwise would be the
// same overreach this bug is about. The check is named for what it measures.
import type { AIValidateKeyResult } from './ai/types'

const AUTH_URL = 'https://api.deepgram.com/v1/auth/token'

/** Same 10s ceiling the text-AI providers' validateKey probes use. Someone is
 *  sitting on the Settings screen waiting for this. */
const TIMEOUT_MS = 10_000

/**
 * Probe a Deepgram key. Returns the same shape as every AIProvider's
 * `validateKey` so the renderer's single verdict path (`testResult` ->
 * `deriveStatusDot` -> `STATUS_DOT_LABEL`) needs no second branch.
 *
 * `models` is [] on success rather than a model list: Deepgram's models are
 * chosen by the transcription pipeline, not by the model picker, and inventing
 * entries here would put names into a field whose only consumers are text-AI
 * surfaces. Empty is the honest value.
 *
 * `fetchImpl` is injectable for tests, matching transcribeVoiceNote's own
 * signature in assistant/voice-note.ts — the other place this app talks to
 * Deepgram over REST.
 */
export async function validateDeepgramKey(
  key: string,
  fetchImpl: typeof fetch = fetch
): Promise<AIValidateKeyResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, reason: 'Enter a key first.' }

  let response: Response
  try {
    response = await fetchImpl(AUTH_URL, {
      method: 'GET',
      // Exactly the scheme the live pipeline uses (`Token <key>`), so this
      // authenticates the same way the thing it is predicting will.
      headers: { Authorization: `Token ${trimmed}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    // A timeout and a DNS failure are indistinguishable to the user and have
    // the same fix, and neither is evidence about the KEY. Say so, rather than
    // reporting a network problem as a rejected credential.
    return { ok: false, reason: 'Could not reach Deepgram to check this key.' }
  }

  if (response.ok) return { ok: true, models: [] }

  return { ok: false, reason: reasonForStatus(response.status) }
}

/**
 * HTTP status -> the words the user reads.
 *
 * The 429 wording is LOAD-BEARING, not prose: `deriveStatusDot` classifies a
 * failure by running /rate.?limit/i over this string, so a 429 that does not
 * literally say "rate limit" renders a red "Key invalid" dot and sends someone
 * to replace a perfectly good key. Pinned by a test for exactly that reason.
 */
function reasonForStatus(status: number): string {
  if (status === 401) return 'Deepgram rejected this key. Check it in Settings → API keys.'
  if (status === 403) {
    return 'Deepgram accepted the key but refused the request (403) — the key may lack permission for this project.'
  }
  if (status === 429) return 'Deepgram is rate limiting this key. Try again shortly.'
  if (status >= 500) return `Deepgram had a server error (HTTP ${status}). Try again shortly.`
  return `Deepgram rejected this key (HTTP ${status}).`
}
