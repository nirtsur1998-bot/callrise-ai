// BUG-164 — the rep's microphone hearing the OTHER PARTY through their
// speakers, and the transcript recording it as something the rep said.
//
// Measured on a real call before the fix: 38% of segments byte-identical on
// BOTH channels at a zero millisecond offset. echoCancellation:true is already
// requested and cannot help — Chromium only cancels what Chromium rendered,
// and the far end is played by Zoom/Teams.
//
// The founder's decision (2026-09-02): deduplicate at ingestion rather than
// telling the rep to wear headphones — "that's the app blaming me for its own
// limitation, and most people won't change how they work" — and count it, so
// the rate can be measured rather than guessed.
//
// The asymmetry that makes dropping the channel-0 copy safe rather than a coin
// flip: channel 1 is the system loopback, which carries only what the machine
// PLAYS. The rep's own voice is never played back by the machine, so it cannot
// appear on channel 1. Text on both channels came from the far end, always.
import { describe, expect, it } from 'vitest'
import { TranscriptAccumulator } from '../transcript-accumulator'

type Word = { text: string; speaker: number; channel?: number }
const w = (text: string, speaker: number, channel: number): Word => ({ text, speaker, channel })

/** Feed one finalized run in, the way the socket does. */
function feed(acc: TranscriptAccumulator, words: Word[], epoch = 0): void {
  acc.ingest({
    transcript: words.map((x) => x.text).join(' '),
    words,
    isFinal: true,
    speakerEpoch: epoch,
    speakerCertain: true,
    minConfidence: null,
    multichannel: true
  } as never)
}

const BUYER_LINE = 'my finance director has to approve anything over twenty thousand dollars'
const REP_LINE = 'what would he need to see from us to be comfortable signing that off'

describe('BUG-164 — microphone echo of the other party', () => {
  it('drops the channel-0 copy when the same line arrives on both channels', () => {
    const acc = new TranscriptAccumulator()
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 1, 1))) // loopback: the buyer
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 0, 0))) // mic: the echo
    const segs = acc.snapshot().filter((s) => s.kind !== 'gap')
    expect(segs).toHaveLength(1)
    expect(segs[0].channel).toBe(1)
    expect(acc.getEchoDroppedCount()).toBe(1)
  })

  // THE CONTROL THAT MATTERS MOST. Without it the fix could be "drop every
  // channel-0 segment" and the assertion above would still pass.
  it('CONTROL — keeps what the rep actually said', () => {
    const acc = new TranscriptAccumulator()
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 1, 1)))
    feed(acc, REP_LINE.split(' ').map((t) => w(t, 0, 0)))
    const segs = acc.snapshot().filter((s) => s.kind !== 'gap')
    expect(segs).toHaveLength(2)
    expect(segs.some((s) => s.channel === 0)).toBe(true)
    expect(acc.getEchoDroppedCount()).toBe(0)
  })

  // THE ORDER THAT ACTUALLY HAPPENS. Driving a real call showed the
  // microphone's final arrives BEFORE the loopback's — the mic is local, the
  // loopback lags. The first version of this fix only handled loopback-first,
  // so it passed every unit test and was a complete no-op in the field: 3 of 5
  // mic lines still duplicated on a driven call, and not one [echo] log line.
  it('drops the EARLIER mic copy when the loopback arrives second', () => {
    const acc = new TranscriptAccumulator()
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 0, 0))) // mic first
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 1, 1))) // loopback second
    const segs = acc.snapshot().filter((s) => s.kind !== 'gap')
    expect(segs).toHaveLength(1)
    expect(segs[0].channel).toBe(1)
    expect(acc.getEchoDroppedCount()).toBe(1)
  })

  it('CONTROL — the other party is never the one removed', () => {
    const acc = new TranscriptAccumulator()
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 0, 0)))
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 1, 1)))
    // Whichever copy goes, a channel-1 segment must always survive: losing the
    // buyer's words is the one outcome worse than the duplication.
    expect(acc.snapshot().some((s) => s.channel === 1)).toBe(true)
  })

  it('CONTROL — a short utterance both people plausibly said is kept', () => {
    const acc = new TranscriptAccumulator()
    feed(acc, [w('yes', 1, 1)])
    feed(acc, [w('yes', 0, 0)])
    const segs = acc.snapshot().filter((s) => s.kind !== 'gap')
    expect(segs).toHaveLength(2)
    expect(acc.getEchoDroppedCount()).toBe(0)
  })

  it('matches despite punctuation and casing, which the two channels differ on', () => {
    const acc = new TranscriptAccumulator()
    feed(acc, 'My finance director has to approve anything over twenty thousand dollars.'.split(' ').map((t) => w(t, 1, 1)))
    feed(acc, 'my finance director has to approve anything over twenty thousand dollars'.split(' ').map((t) => w(t, 0, 0)))
    expect(acc.getEchoDroppedCount()).toBe(1)
  })

  it('CONTROL — a genuine repetition much later is NOT treated as an echo', () => {
    const acc = new TranscriptAccumulator()
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 1, 1)))
    // Push the loopback copy out of the lookback window with unrelated turns.
    for (let i = 0; i < 10; i++) {
      feed(acc, [w('filler' + i, 1, 1), w('words', 1, 1), w('here', 1, 1), w('now', 1, 1)])
    }
    feed(acc, BUYER_LINE.split(' ').map((t) => w(t, 0, 0)))
    expect(acc.getEchoDroppedCount()).toBe(0)
    expect(acc.snapshot().some((s) => s.channel === 0)).toBe(true)
  })

  it('counts every drop, so the field rate can be measured not guessed', () => {
    const acc = new TranscriptAccumulator()
    for (const line of [BUYER_LINE, 'and every vendor has to complete our security questionnaire first']) {
      feed(acc, line.split(' ').map((t) => w(t, 1, 1)))
      feed(acc, line.split(' ').map((t) => w(t, 0, 0)))
    }
    expect(acc.getEchoDroppedCount()).toBe(2)
  })
})
