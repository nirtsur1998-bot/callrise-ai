// M28 Phase 3 — the voice-note module: transcription client (fetch injected,
// no network) and the media store (real temp-dir files, path-safety guards).
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteVoiceNote,
  readVoiceNote,
  saveVoiceNote,
  transcribeVoiceNote,
  MAX_VOICE_NOTE_BYTES
} from '../voice-note'

const ORIGINAL_KEY = process.env.DEEPGRAM_API_KEY

function fakeFetch(
  status: number,
  body: unknown
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-note-test-'))
  process.env.DEEPGRAM_API_KEY = 'dg-test-key'
})

afterEach(async () => {
  if (ORIGINAL_KEY === undefined) delete process.env.DEEPGRAM_API_KEY
  else process.env.DEEPGRAM_API_KEY = ORIGINAL_KEY
  await rm(dir, { recursive: true, force: true })
})

describe('transcribeVoiceNote', () => {
  const audio = Buffer.from('fake-webm-bytes')

  it('happy path: parses the Deepgram prerecorded response shape', async () => {
    const result = await transcribeVoiceNote(
      audio,
      'audio/webm',
      fakeFetch(200, {
        results: { channels: [{ alternatives: [{ transcript: ' Prep me for the 2pm. ' }] }] }
      })
    )
    expect(result).toEqual({ ok: true, text: 'Prep me for the 2pm.' })
  })

  it('no key → honest no-key message naming the fix, no network call', async () => {
    delete process.env.DEEPGRAM_API_KEY
    const neverCalled = (async () => {
      throw new Error('should not be called')
    }) as unknown as typeof fetch
    const result = await transcribeVoiceNote(audio, 'audio/webm', neverCalled)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no-key')
    expect(result.message).toContain('Settings')
  })

  it('oversized audio is refused before any upload', async () => {
    const big = Buffer.alloc(MAX_VOICE_NOTE_BYTES + 1)
    const result = await transcribeVoiceNote(big, 'audio/webm', fakeFetch(200, {}))
    expect(result.error).toBe('too-large')
  })

  it('network failure and non-200 both degrade to keep-your-recording messages', async () => {
    const throwing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect((await transcribeVoiceNote(audio, 'audio/webm', throwing)).error).toBe('network')
    expect((await transcribeVoiceNote(audio, 'audio/webm', fakeFetch(429, {}))).error).toBe('api')
  })

  it('a silent recording (empty transcript) is reported, not returned as ""', async () => {
    const result = await transcribeVoiceNote(
      audio,
      'audio/webm',
      fakeFetch(200, { results: { channels: [{ alternatives: [{ transcript: '  ' }] }] } })
    )
    expect(result.error).toBe('empty')
  })
})

describe('media store', () => {
  it('save → read round-trips the exact bytes; delete removes the file', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5])
    const mediaId = await saveVoiceNote(dir, bytes, 'webm')
    expect(mediaId).toMatch(/\.webm$/)
    const back = await readVoiceNote(dir, mediaId)
    expect(back && Buffer.compare(back, bytes)).toBe(0)
    await deleteVoiceNote(dir, mediaId)
    expect(await readVoiceNote(dir, mediaId)).toBeNull()
    expect(await readdir(join(dir, 'media'))).toEqual([])
  })

  it('read/delete refuse traversal-shaped and wrong-extension ids', async () => {
    expect(await readVoiceNote(dir, '../../evil.webm')).toBeNull()
    expect(await readVoiceNote(dir, 'plain-id')).toBeNull()
    await deleteVoiceNote(dir, '../outside.webm') // must not throw or escape
  })
})
