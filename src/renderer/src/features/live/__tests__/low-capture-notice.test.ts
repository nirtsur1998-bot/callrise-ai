// BUG-176 / BUG-179 — the in-call notice for near-total capture loss.
//
// Every fixture is a REAL call from the founder's store, named by date and by
// its actual word count. The first version of this rule counted SEGMENTS and
// passed a fixture suite exactly like this one — it was the corpus run, not the
// unit tests, that found it would warn about a complete 910-word transcript.
// So the 2026-07-30 case below is here permanently: it is the one that caught it.
import { describe, expect, it } from 'vitest'
import {
  lowCaptureNotice,
  LOW_CAPTURE_MIN_SUBMITTED_SEC,
  LOW_CAPTURE_WORDS_PER_MIN
} from '../low-capture-notice'
import type { TranscriptionHealthEvent } from '../../../../../preload/index.d'

const health = (over: Partial<TranscriptionHealthEvent> = {}): TranscriptionHealthEvent =>
  ({
    submittedSec: 342,
    acknowledgedSec: 340,
    lagSec: 0.2,
    medianLagSec: 0.2,
    tier: 'none',
    queuedSec: 0,
    shedSec: 0,
    resets: 0,
    gaps: [],
    liveness: 'ok',
    driftPpm: 40,
    rejectedProducerFrames: 0,
    ...over
  }) as TranscriptionHealthEvent

/** n words, split across `chunks` segments — shape must not change the verdict. */
const words = (n: number, chunks = 1): { text: string }[] => {
  if (n === 0) return []
  const per = Math.ceil(n / chunks)
  const out: { text: string }[] = []
  let left = n
  while (left > 0) {
    const take = Math.min(per, left)
    out.push({ text: Array.from({ length: take }, () => 'word').join(' ') })
    left -= take
  }
  return out
}

describe('BUG-176 — near-total capture loss is said out loud, during the call', () => {
  it('fires on a real 12.3-minute call that transcribed NOTHING (2026-09-01)', () => {
    const n = lowCaptureNotice({ health: health({ submittedSec: 738 }), segments: [] })
    expect(n).not.toBeNull()
    expect(n!.title).toContain('Only 0 words have been transcribed')
  })

  it('fires on a real 5.5-minute call that transcribed ONE word', () => {
    const n = lowCaptureNotice({ health: health({ submittedSec: 330 }), segments: words(1) })
    expect(n).not.toBeNull()
    expect(n!.title).toContain('Only 1 word has been transcribed')
  })

  // THE CONTROL THAT CAUGHT THE FIRST VERSION. 910 words in 8.4 minutes,
  // arriving as ONE segment because the call was mono. Nothing was lost. The
  // segments-per-minute rule warned about this call; counting words does not.
  it('CONTROL — a COMPLETE 910-word transcript in a single segment is not warned about', () => {
    expect(
      lowCaptureNotice({ health: health({ submittedSec: 504 }), segments: words(910, 1) })
    ).toBeNull()
  })

  it('CONTROL — the same words split across 200 segments give the same verdict', () => {
    // Shape must be irrelevant: the rule measures words, not segmentation.
    expect(
      lowCaptureNotice({ health: health({ submittedSec: 504 }), segments: words(910, 200) })
    ).toBeNull()
  })

  it('CONTROL — a one-sided call (~40 wpm) is deliberately OUT of scope', () => {
    // The founder's 2026-09-02 call: 214 words in 5.7 min. Half a conversation,
    // not a lost one. Warning here would reach into the continuum where a
    // genuinely quiet call lives; the call-detail marker covers this case.
    expect(
      lowCaptureNotice({ health: health({ submittedSec: 342 }), segments: words(214) })
    ).toBeNull()
  })

  it('CONTROL — a healthy call is silent', () => {
    expect(
      lowCaptureNotice({ health: health({ submittedSec: 990 }), segments: words(1570, 204) })
    ).toBeNull()
  })

  it('CONTROL — the sparsest call ABOVE the line stays quiet', () => {
    // 5 wpm exactly: at the threshold, not below it.
    const secs = 600
    expect(
      lowCaptureNotice({
        health: health({ submittedSec: secs }),
        segments: words((LOW_CAPTURE_WORDS_PER_MIN * secs) / 60)
      })
    ).toBeNull()
  })

  it('CONTROL — gap markers are not transcribed words', () => {
    const n = lowCaptureNotice({
      health: health({ submittedSec: 600 }),
      segments: [{ text: '[gap: 30s]', kind: 'gap' }, ...words(2)]
    })
    expect(n).not.toBeNull()
    expect(n!.title).toContain('Only 2 words')
  })

  it('CONTROL — nobody speaking (liveness "silent") is not our failure to report', () => {
    expect(lowCaptureNotice({ health: health({ liveness: 'silent' }), segments: [] })).toBeNull()
  })

  it('CONTROL — a dead capture or socket already has its own notice, never two', () => {
    for (const liveness of ['capture-dead', 'socket-dead'] as const) {
      expect(lowCaptureNotice({ health: health({ liveness }), segments: [] })).toBeNull()
    }
  })

  it('CONTROL — a call that has barely started is not judged', () => {
    expect(
      lowCaptureNotice({
        health: health({ submittedSec: LOW_CAPTURE_MIN_SUBMITTED_SEC - 1 }),
        segments: []
      })
    ).toBeNull()
    expect(
      lowCaptureNotice({
        health: health({ submittedSec: LOW_CAPTURE_MIN_SUBMITTED_SEC }),
        segments: []
      })
    ).not.toBeNull()
  })

  it('CONTROL — no health payload yet means no claim', () => {
    expect(lowCaptureNotice({ health: null, segments: [] })).toBeNull()
  })
})
