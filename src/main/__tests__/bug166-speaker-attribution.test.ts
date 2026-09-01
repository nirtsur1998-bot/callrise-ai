// BUG-166 — the Sales Brain was told WHAT to extract but never WHO said it.
//
// extractMemoriesFromCall writes memories scoped `rep` and `business` — facts
// about the user's own selling and their own company — from a transcript
// labelled only "Speaker 0" / "Speaker 1". Found in the founder's real memory
// store: the buyer's "my finance director has to approve anything over twenty
// thousand dollars" stored as "The rep's finance director needs to sign off on
// deals over $20,000", scope `rep`, confidence 1.0.
//
// The app knows: recorder.ts puts the microphone on channel 0 and the other
// party's loopback on channel 1. This asserts the transcript the model is
// actually shown carries that, and — the half that matters more — that it
// does NOT claim to know when the channels cannot tell it.
import { describe, expect, it, beforeEach, vi } from 'vitest'

const completeWithFallback = vi.fn()
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: class extends Error {}
}))

const { extractMemoriesFromCall } = await import('../memory/extraction')

function seg(speaker: number, channel: number | undefined, text: string): never {
  return { speaker, channel, text, startMs: speaker * 1000 } as never
}
/** The prompt the model was actually handed, which is the only thing that
 *  decides what it can know. */
const promptSent = (): string => {
  const call = completeWithFallback.mock.calls[0]
  return String(call?.[0]?.messages?.[0]?.content ?? '')
}

beforeEach(() => {
  completeWithFallback.mockReset()
  completeWithFallback.mockResolvedValue({ toolInput: { candidates: [] } })
})

describe('BUG-166 — the transcript must say who is the rep', () => {
  it('labels channel 0 as the rep and channel 1 as the other party', async () => {
    await extractMemoriesFromCall(
      [
        seg(0, 0, 'Thanks for the time, let me walk you through pricing.'),
        seg(1, 1, 'My finance director has to approve anything over twenty thousand dollars.')
      ],
      'call-1',
      null
    )
    const prompt = promptSent()
    expect(prompt).toContain('REP (the user): Thanks for the time')
    expect(prompt).toContain('OTHER PARTY (the client): My finance director')
    // The exact failure that produced the bad memory: an anonymous number.
    expect(prompt).not.toContain('Speaker 0:')
    expect(prompt).not.toContain('Speaker 1:')
  })

  it('tells the model the labels are authoritative, not a hint', async () => {
    await extractMemoriesFromCall([seg(0, 0, 'Hello there, thanks for joining.')], 'call-2', null)
    expect(promptSent()).toContain('AUTHORITATIVE')
  })

  // THE CONTROL, and the more important half. A fix that always says "REP"
  // would pass every assertion above while inventing certainty that does not
  // exist. On a mono capture there is no channel signal, so the transcript
  // must stay anonymous.
  it('falls back to numbered speakers when the channels cannot tell it', async () => {
    await extractMemoriesFromCall(
      [
        seg(0, undefined, 'Thanks for the time, let me walk you through pricing.'),
        seg(1, undefined, 'My finance director has to approve anything over twenty thousand.')
      ],
      'call-3',
      null
    )
    const prompt = promptSent()
    expect(prompt).toContain('Speaker 0:')
    expect(prompt).toContain('Speaker 1:')
    expect(prompt).not.toContain('REP (the user):')
  })

  it('stays anonymous if even ONE segment lacks a usable channel', async () => {
    await extractMemoriesFromCall(
      [seg(0, 0, 'Thanks for the time today.'), seg(1, 7, 'Some third source entirely.')],
      'call-4',
      null
    )
    expect(promptSent()).toContain('Speaker 0:')
    expect(promptSent()).not.toContain('REP (the user):')
  })

  it('labels a mic-only call, where every turn really is the rep', async () => {
    await extractMemoriesFromCall(
      [seg(0, 0, 'Note to self, the pricing page needs rewriting before Tuesday.')],
      'call-5',
      null
    )
    expect(promptSent()).toContain('REP (the user): Note to self')
  })
})
