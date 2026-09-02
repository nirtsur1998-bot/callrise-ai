// BUG-163 — a model answering "null" as TEXT becomes a person called null.
//
// Found by screenshotting the call-detail screen after a driven call: the
// banner read "Detected null on this call — no contact linked yet." with a
// button offering "Create contact for null". The stored record was
//   { name: 'null', source: 'self-intro', confidence: 'medium' }
// — the four-character STRING, not a JS null, so every truthiness guard
// between the model and the CRM passed it happily.
//
// The cause is in the schema, not the model. `buyerName` is declared
// `type: ['string','null']` AND listed in `required`. A provider that
// coerces a required field to its primary declared type emits the word
// "null" rather than the JSON literal, and liveCue's guard
//   typeof raw.buyerName === 'string' && raw.buyerName.trim()
// accepts it. Same class as BUG-162: the model's literal answer collides
// with the app's own value space.
//
// Drives the REAL liveCue with only completeWithFallback mocked — the claim
// under test is OUR parsing of a model reply, not provider behaviour.
import { describe, expect, it, beforeEach, vi } from 'vitest'

const completeWithFallback = vi.fn()
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: class extends Error {}
}))
vi.mock('../app-settings', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isSelfIntroExtractionAllowed: () => true
}))

const { liveCue } = await import('../live-cue')

const TRANSCRIPT = [
  'Speaker 0: Thanks for making the time today, I wanted to walk you through the pricing.',
  'Speaker 1: Sure, though honestly your price is much higher than what Gong quoted us.'
].join('\n')

const reply = (buyerName: unknown, buyerSpeaker: unknown = 1): void => {
  completeWithFallback.mockResolvedValue({
    toolInput: {
      repSpeaker: 0,
      cue: 'objection',
      text: 'Ask what they are comparing the price to',
      buyerName,
      buyerSpeaker
    }
  })
}

beforeEach(() => {
  completeWithFallback.mockReset()
})

describe('BUG-163 — placeholder words are absence, not a name', () => {
  // The exact shape observed on disk.
  it('rejects the literal string "null" as a buyer name', async () => {
    reply('null')
    const r = await liveCue({ transcript: TRANSCRIPT, repSpeaker: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.buyerName).toBeNull()
    // buyerSpeaker must fall with it — a speaker number for a name that
    // does not exist would still label the transcript row.
    expect(r.buyerSpeaker).toBeNull()
  })

  // Every other way a model spells "I don't know" in a required string field.
  it.each([
    'NULL',
    'None',
    'none',
    'undefined',
    'N/A',
    'n/a',
    'unknown',
    'Unknown',
    'not specified',
    'not provided',
    'unclear',
    '-',
    '""'
  ])('rejects %j', async (placeholder) => {
    reply(placeholder)
    const r = await liveCue({ transcript: TRANSCRIPT, repSpeaker: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.buyerName).toBeNull()
  })

  // THE CONTROL. Without this the fix could be "always return null" and the
  // assertions above would all still pass.
  it('still accepts a real name', async () => {
    reply('Sarah Chen')
    const r = await liveCue({ transcript: TRANSCRIPT, repSpeaker: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.buyerName).toBe('Sarah Chen')
    expect(r.buyerSpeaker).toBe(1)
  })

  // A real name that merely CONTAINS a placeholder word must survive —
  // a substring check instead of an exact match would eat these.
  it.each(['Nunes', 'Noneli Adeyemi', 'Anna Nullman'])(
    'still accepts %j',
    async (name) => {
      reply(name)
      const r = await liveCue({ transcript: TRANSCRIPT, repSpeaker: 0 })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.buyerName).toBe(name)
    }
  )
})
