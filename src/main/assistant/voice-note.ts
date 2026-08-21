// M28 Phase 3 — voice messages for the Rise composer. One-shot recording →
// Deepgram PRERECORDED REST → text lands in the composer FOR REVIEW (never
// auto-sent — a mis-transcription into an AI that acts on it is the brief's
// named footgun).
//
// Deliberately NOT built on src/main/transcription.ts: that module is the
// live-call pipeline — its start unconditionally opens a call journal, marks
// a live call active, and feeds the coaching engine (Phase 0 map). A voice
// note is a deliberate, self-recorded utterance: different surface,
// different lifecycle, ZERO overlap with call detection or the consent
// architecture (the user's own voice, recorded by their own explicit
// press — stated here per the brief, not assumed silently).
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Caps: a voice note is a message, not a meeting. */
export const MAX_VOICE_NOTE_BYTES = 15 * 1024 * 1024 // ~5 min of opus, generously
export const MAX_VOICE_NOTE_MS = 5 * 60 * 1000

const MEDIA_ID_RE = /^[A-Za-z0-9-]{1,64}$/

export function isSafeMediaId(id: unknown): id is string {
  return typeof id === 'string' && MEDIA_ID_RE.test(id)
}

export function voiceMediaDir(conversationsDir: string): string {
  return join(conversationsDir, 'media')
}

export interface TranscribeResult {
  ok: boolean
  /** Machine class; `message` is the human copy shown in the composer. */
  error?: 'no-key' | 'too-large' | 'network' | 'api' | 'empty'
  message?: string
  text?: string
}

/** POST the audio to Deepgram's prerecorded endpoint. Same key the live
 *  pipeline uses (process.env.DEEPGRAM_API_KEY, loaded from safeStorage at
 *  startup), read fresh per call. Honest degradation ladder: no key → a
 *  clear message naming the fix; API/network failures → the composer keeps
 *  the recording so nothing is lost, and the user can retry or just type. */
export async function transcribeVoiceNote(
  audio: Buffer,
  mimeType: string,
  fetchImpl: typeof fetch = fetch
): Promise<TranscribeResult> {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) {
    return {
      ok: false,
      error: 'no-key',
      message: 'Voice notes need your Deepgram key — add it in Settings → API keys.'
    }
  }
  if (audio.byteLength > MAX_VOICE_NOTE_BYTES) {
    return { ok: false, error: 'too-large', message: 'That recording is too long to transcribe.' }
  }
  let response: Response
  try {
    response = await fetchImpl(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': mimeType },
        body: new Uint8Array(audio)
      }
    )
  } catch {
    return {
      ok: false,
      error: 'network',
      message: 'Could not reach the transcription service — check your connection and try again.'
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      error: 'api',
      message: `Transcription failed (${response.status}). Your recording is kept — try again or type instead.`
    }
  }
  try {
    const body = (await response.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] }
    }
    const text = body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? ''
    if (!text) {
      return {
        ok: false,
        error: 'empty',
        message: 'No speech detected in that recording.'
      }
    }
    return { ok: true, text }
  } catch {
    return {
      ok: false,
      error: 'api',
      message: 'Transcription returned an unreadable response. Try again or type instead.'
    }
  }
}

/** Persist the audio so the sent message can play it back. Plain file write
 *  (not writeJsonAtomic — binary, and a torn write here loses a replay, not
 *  a record; the message's own JSON stays the source of truth). */
export async function saveVoiceNote(
  conversationsDir: string,
  audio: Buffer,
  ext: 'webm' | 'ogg'
): Promise<string> {
  const dir = voiceMediaDir(conversationsDir)
  await fs.mkdir(dir, { recursive: true })
  const mediaId = `${randomUUID()}.${ext}`
  await fs.writeFile(join(dir, mediaId), audio)
  return mediaId
}

export async function readVoiceNote(
  conversationsDir: string,
  mediaId: string
): Promise<Buffer | null> {
  if (!isSafeMediaId(mediaId.replace(/\.(webm|ogg)$/, '')) || !/\.(webm|ogg)$/.test(mediaId)) {
    return null
  }
  try {
    return await fs.readFile(join(voiceMediaDir(conversationsDir), mediaId))
  } catch {
    return null
  }
}

export async function deleteVoiceNote(conversationsDir: string, mediaId: string): Promise<void> {
  if (!/\.(webm|ogg)$/.test(mediaId)) return
  await fs.unlink(join(voiceMediaDir(conversationsDir), mediaId)).catch(() => {})
}
