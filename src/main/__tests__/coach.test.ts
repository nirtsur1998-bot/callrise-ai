import { describe, expect, it } from 'vitest'
import { computeMetrics, makeFreeTextScrubber, makeVerifier, normalize } from '../coach'
import type { CallSegment } from '../calls-fs'

const seg = (speaker: number, text: string): CallSegment => ({ speaker, text })

describe('normalize', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalize('  Hello   World  ')).toBe('hello world')
  })

  it('strips an accidental "Speaker N:" label', () => {
    expect(normalize('Speaker 2: I need to think about it')).toBe('i need to think about it')
  })
})

describe('computeMetrics', () => {
  it('computes talk ratio, word counts, and turn count for a real rep speaker', () => {
    const segments = [
      seg(0, 'Hi there thanks for joining today'), // rep, 6 words
      seg(1, 'Sure no problem'), // buyer, 3 words
      seg(0, 'Great so tell me about your current setup') // rep, 8 words
    ]
    const metrics = computeMetrics(segments, 60_000, 0)
    expect(metrics.repSpeaker).toBe(0)
    expect(metrics.totalWords).toBe(17)
    expect(metrics.repWords).toBe(14)
    expect(metrics.talkRatio).toBeCloseTo(14 / 17, 5)
    expect(metrics.turns).toBe(3) // three consecutive-speaker runs, none merged
    expect(metrics.singleSpeaker).toBe(false)
  })

  it('merges consecutive same-speaker segments into one turn for monologue length', () => {
    const segments = [
      seg(0, 'one two three'),
      seg(0, 'four five six'), // same speaker immediately after — one turn, 6 words
      seg(1, 'ok')
    ]
    const metrics = computeMetrics(segments, 60_000, 0)
    expect(metrics.turns).toBe(2)
    expect(metrics.longestMonologueWords).toBe(6)
  })

  it('is null-safe when repSpeaker is not actually present in the transcript', () => {
    const segments = [seg(0, 'hello'), seg(1, 'hi')]
    const metrics = computeMetrics(segments, 60_000, 5) // 5 never spoke
    expect(metrics.repSpeaker).toBeNull()
    expect(metrics.repWords).toBe(0)
    expect(metrics.talkRatio).toBeNull()
    expect(metrics.longestMonologueWords).toBe(0)
  })

  it('is null-safe when repSpeaker is null (never identified)', () => {
    const segments = [seg(0, 'hello there'), seg(1, 'hi')]
    const metrics = computeMetrics(segments, 60_000, null)
    expect(metrics.repSpeaker).toBeNull()
    expect(metrics.talkRatio).toBeNull()
  })

  it('detects a single-speaker (monologue-only) call', () => {
    const segments = [seg(0, 'one'), seg(0, 'two')]
    expect(computeMetrics(segments, 60_000, 0).singleSpeaker).toBe(true)
  })

  it("counts question marks only in the rep's own words once a rep is known", () => {
    const segments = [seg(0, 'How are you?'), seg(1, 'Good, and you? Great, thanks.')]
    const metrics = computeMetrics(segments, 60_000, 0)
    expect(metrics.questionCount).toBe(1) // only the rep's "How are you?"
  })

  it('counts question marks across everyone when no rep is identified', () => {
    const segments = [seg(0, 'How are you?'), seg(1, 'Good, and you?')]
    const metrics = computeMetrics(segments, 60_000, null)
    expect(metrics.questionCount).toBe(2)
  })

  it('computes words-per-minute and derives longest-monologue in minutes from it', () => {
    // 30 words total over 60s = 30 wpm.
    const segments = [seg(0, Array(30).fill('word').join(' '))]
    const metrics = computeMetrics(segments, 60_000, 0)
    expect(metrics.wordsPerMinute).toBe(30)
    expect(metrics.longestMonologueMinutes).toBe(1) // 30 words / 30 wpm = 1.0 min
  })

  it('never divides by a zero/negative duration — pace fields stay null instead of Infinity/NaN', () => {
    const segments = [seg(0, 'hello world')]
    const metrics = computeMetrics(segments, 0, 0)
    expect(metrics.wordsPerMinute).toBeNull()
    expect(metrics.longestMonologueMinutes).toBeNull()
    expect(Number.isFinite(metrics.wordsPerMinute)).toBe(false) // null, not NaN/Infinity
  })

  it('handles an empty transcript without throwing', () => {
    const metrics = computeMetrics([], 60_000, 0)
    expect(metrics.totalWords).toBe(0)
    expect(metrics.turns).toBe(0)
    expect(metrics.singleSpeaker).toBe(true) // speakers.size (0) <= 1
  })
})

describe('makeVerifier — evidence grounding', () => {
  const segments = [
    seg(0, 'I think our pricing might be too high for you honestly'),
    seg(1, 'Actually the budget is fine, my concern is the integration timeline')
  ]

  it('verifies a quote that the claimed speaker actually said', () => {
    const verify = makeVerifier(segments, 0)
    const evidence = verify('I think our pricing might be too high for you honestly', 0)
    expect(evidence?.verified).toBe(true)
  })

  it('does NOT verify a quote attributed to the wrong speaker index, even if the words exist elsewhere', () => {
    const verify = makeVerifier(segments, 0)
    // These words were said by speaker 1, not the claimed speaker 0.
    const evidence = verify('my concern is the integration timeline', 0)
    expect(evidence).toBeDefined()
    expect(evidence?.verified).toBe(false)
  })

  it("never marks the buyer's own words as verified rep evidence, even correctly attributed", () => {
    // The model correctly says speaker 1 said it — but repSpeaker is 0, so
    // this can never be shown as "the rep said/did this".
    const verify = makeVerifier(segments, 0)
    const evidence = verify('my concern is the integration timeline', 1)
    expect(evidence?.verified).toBe(false)
  })

  it('does not verify a quote that never appears in the transcript at all', () => {
    // Still returns evidence (so the caller has the claimed quote to inspect),
    // but never as verified — only a genuinely-undersized quote is dropped
    // outright (see the MIN_QUOTE_CHARS case below).
    const verify = makeVerifier(segments, 0)
    const evidence = verify('this sentence was never said by anyone', 0)
    expect(evidence?.verified).toBe(false)
  })

  it('rejects a quote stitched across two different turns', () => {
    const verify = makeVerifier(segments, 0)
    // Tail of turn 0 + head of turn 1 — must not verify as one continuous quote.
    const evidence = verify('too high for you honestly actually the budget', 0)
    expect(evidence?.verified).toBe(false)
  })

  it('rejects a quote shorter than the minimum meaningful length', () => {
    const verify = makeVerifier(segments, 0)
    expect(verify('I think', 0)).toBeUndefined() // under MIN_QUOTE_CHARS
  })

  it('is case- and whitespace-insensitive when matching', () => {
    const verify = makeVerifier(segments, 0)
    const evidence = verify('I THINK   our pricing might be too high', 0)
    expect(evidence?.verified).toBe(true)
  })

  it('is undefined when repSpeaker is null, even for an otherwise-matching quote', () => {
    const verify = makeVerifier(segments, null)
    const evidence = verify('I think our pricing might be too high for you honestly', 0)
    expect(evidence?.verified).toBe(false)
  })

  it('merges consecutive same-speaker segments before matching, same as computeMetrics', () => {
    const split = [seg(0, 'the first half of the sentence'), seg(0, 'and the second half here')]
    const verify = makeVerifier(split, 0)
    const evidence = verify('the first half of the sentence and the second half here', 0)
    expect(evidence?.verified).toBe(true)
  })
})

describe('makeFreeTextScrubber — the transcripts-stay-local backstop', () => {
  const segments = [
    seg(0, 'Our new enterprise pricing tier starts at nine thousand dollars per year')
  ]

  it('leaves an ordinary paraphrase untouched', () => {
    const scrub = makeFreeTextScrubber(segments)
    expect(scrub('The rep should ask about budget earlier in the call.')).toBe(
      'The rep should ask about budget earlier in the call.'
    )
  })

  it('cuts off a field the moment it runs 8+ consecutive words verbatim from the transcript', () => {
    const scrub = makeFreeTextScrubber(segments)
    const leaked =
      'The rep said our new enterprise pricing tier starts at nine thousand dollars per year which is too specific'
    const result = scrub(leaked)
    expect(result).not.toContain('nine thousand dollars')
    expect(result.endsWith('[…]')).toBe(true)
  })

  it('replaces an entirely-verbatim field with a placeholder rather than an empty string', () => {
    const scrub = makeFreeTextScrubber(segments)
    const result = scrub('our new enterprise pricing tier starts at nine thousand dollars per year')
    expect(result).toBe('[Removed: this text quoted the transcript verbatim.]')
  })

  it('passes through an empty string unchanged', () => {
    const scrub = makeFreeTextScrubber(segments)
    expect(scrub('')).toBe('')
  })
})
