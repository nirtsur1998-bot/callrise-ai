// M26 Phase 4.3 — the bar: what the rep SEES and what gets SAVED must be
// byte-identical to what they would have had before the transcript moved into
// the main process.
//
// 4.1's equivalence test proved main's accumulator matches the renderer's.
// That is no longer sufficient on its own, because the renderer no longer runs
// its accumulator at all — it runs a *mirror*, rebuilt from deltas over IPC.
// So there is a second place the bytes could drift: the patch protocol itself.
// A splice with an off-by-one `from`, a dropped no-op, a reset that does not
// reset — any of those produce a transcript that looks plausible and is wrong.
//
// This test closes that gap. It drives:
//   (a) the frozen pre-4.3 renderer logic — the reference,
//   (b) main's accumulator -> diffFrom -> patches -> applyPatch — what actually
//       runs now,
// through the same event stream and asserts JSON.stringify equality, which
// pins key ORDER and undefined-vs-absent too, not merely deep equality.
import { describe, expect, it } from 'vitest'
import { groupWords, mergeSegments } from '../segments'
import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'
import {
  TranscriptAccumulator,
  type AccumulatedSegment,
  type TranscriptResult
} from '../../../../../main/live/transcript-accumulator'
import { applyPatch, diffFrom } from '../../../../../main/live/transcript-patch'

/**
 * The renderer's behaviour as it stood immediately before 4.3, transcribed
 * from useTranscription.ts and using the renderer's own groupWords/
 * mergeSegments. This is the oracle: if the migration changed what a rep sees,
 * this disagrees.
 */
class FrozenRenderer {
  segments: CallSegment[] = []
  private repByEpoch = new Map<number, number>()
  private speakerBoundary = false

  private resolveRole(speaker: number, epoch: number, certain: boolean): SpeakerRole {
    if (!certain) return 'unknown'
    const rep = this.repByEpoch.get(epoch)
    if (rep === undefined) return 'unknown'
    return speaker === rep ? 'rep' : 'other'
  }

  ingest(payload: TranscriptResult): void {
    const text = payload.transcript.trim()
    if (!payload.isFinal) return
    const epoch = payload.speakerEpoch
    if (payload.multichannel && !this.repByEpoch.has(epoch)) this.repByEpoch.set(epoch, 0)
    const meta = {
      epoch,
      role: (speaker: number): SpeakerRole =>
        this.resolveRole(speaker, epoch, payload.speakerCertain),
      ...(payload.minConfidence !== null ? { confidence: payload.minConfidence } : {}),
      unlabelled: !payload.speakerCertain
    }
    let runs: CallSegment[] = []
    if (payload.words.length > 0) {
      runs = groupWords(payload.words, meta)
    } else if (text) {
      const last = this.segments.at(-1)
      const lastSpeaker = last?.epoch === epoch ? last.speaker : 0
      const sameEpoch = last?.epoch === epoch
      runs = [
        {
          speaker: lastSpeaker,
          text,
          epoch,
          role: sameEpoch ? this.resolveRole(lastSpeaker, epoch, payload.speakerCertain) : 'unknown',
          ...(payload.minConfidence !== null ? { confidence: payload.minConfidence } : {})
        }
      ]
    }
    if (runs.length > 0) {
      if (this.speakerBoundary) {
        this.speakerBoundary = false
        this.segments = [...this.segments, ...runs]
      } else {
        this.segments = mergeSegments(this.segments, runs)
      }
    }
  }

  ingestGap(marker: string): void {
    this.segments = [...this.segments, { speaker: 0, text: marker, kind: 'gap' }]
    this.speakerBoundary = true
  }

  markSpeakerBoundary(): void {
    this.speakerBoundary = true
  }

  identifyRep(epoch: number, speaker: number): void {
    if (this.repByEpoch.get(epoch) === speaker) return
    this.repByEpoch.set(epoch, speaker)
    let changed = false
    const next = this.segments.map((s) => {
      if (s.epoch !== epoch || s.role !== 'unknown') return s
      if (s.unlabelled) return s
      changed = true
      return { ...s, role: s.speaker === speaker ? ('rep' as const) : ('other' as const) }
    })
    if (changed) this.segments = next
  }
}

/** Main's accumulator plus the real wire protocol, ending in what the renderer
 *  would actually be holding. */
class MainThroughTheWire {
  private acc = new TranscriptAccumulator()
  private lastPublished: AccumulatedSegment[] = []
  /** What the renderer's mirror contains after applying every patch. */
  mirror: AccumulatedSegment[] = []
  patches = 0

  private publish(): void {
    const next = this.acc.snapshot()
    const from = diffFrom(this.lastPublished, next)
    if (from < 0) return
    this.lastPublished = next
    this.patches += 1
    this.mirror = applyPatch(this.mirror, { from, segments: next.slice(from) })
  }

  ingest(p: TranscriptResult): void {
    this.acc.ingest(p)
    this.publish()
  }
  ingestGap(marker: string): void {
    this.acc.ingestGap(marker)
    this.publish()
  }
  markSpeakerBoundary(): void {
    this.acc.markSpeakerBoundary()
  }
  identifyRep(epoch: number, speaker: number): void {
    this.acc.identifyRep(epoch, speaker)
    this.publish()
  }
  /** What main would actually persist. */
  truth(): AccumulatedSegment[] {
    return this.acc.snapshot()
  }
}

type Event =
  | { kind: 'result'; payload: TranscriptResult }
  | { kind: 'gap'; marker: string }
  | { kind: 'boundary' }
  | { kind: 'identifyRep'; epoch: number; speaker: number }

function result(over: Partial<TranscriptResult> = {}): TranscriptResult {
  return {
    transcript: '',
    words: [],
    isFinal: true,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.9,
    multichannel: false,
    ...over
  }
}

function words(...specs: Array<[number, string, number?]>): TranscriptResult['words'] {
  return specs.map(([speaker, text, channel]) =>
    channel === undefined ? { speaker, text } : { speaker, text, channel }
  )
}

/**
 * Drive both sides and assert three things at once:
 *   1. the mirror matches the frozen renderer  — what the rep SEES is unchanged
 *   2. main's own copy matches it too          — what gets SAVED is unchanged
 *   3. (1) and (2) agree                       — the wire lost nothing
 */
function runBoth(events: Event[]): AccumulatedSegment[] {
  const main = new MainThroughTheWire()
  const frozen = new FrozenRenderer()
  for (const e of events) {
    switch (e.kind) {
      case 'result':
        main.ingest(e.payload)
        frozen.ingest(e.payload)
        break
      case 'gap':
        main.ingestGap(e.marker)
        frozen.ingestGap(e.marker)
        break
      case 'boundary':
        main.markSpeakerBoundary()
        frozen.markSpeakerBoundary()
        break
      case 'identifyRep':
        main.identifyRep(e.epoch, e.speaker)
        frozen.identifyRep(e.epoch, e.speaker)
        break
    }
  }
  const reference = JSON.stringify(frozen.segments)
  expect(JSON.stringify(main.mirror)).toBe(reference) // seen
  expect(JSON.stringify(main.truth())).toBe(reference) // saved
  return main.mirror
}

describe('4.3 — the transcript survived moving processes, byte for byte', () => {
  it('a plain two-speaker exchange', () => {
    expect(
      runBoth([{ kind: 'result', payload: result({ words: words([0, 'hi'], [1, 'hello']) }) }])
    ).toHaveLength(2)
  })

  it('a continued turn, which REWRITES the previous segment rather than appending', () => {
    // The case an append-only protocol cannot express, and the reason the wire
    // format is a splice.
    expect(
      runBoth([
        { kind: 'result', payload: result({ words: words([0, 'first']) }) },
        { kind: 'result', payload: result({ words: words([0, 'second']) }) }
      ])
    ).toHaveLength(1)
  })

  it('never merges across an epoch boundary — the reconnect mislabeling hazard', () => {
    expect(
      runBoth([
        { kind: 'result', payload: result({ words: words([0, 'before']), speakerEpoch: 0 }) },
        { kind: 'result', payload: result({ words: words([0, 'after']), speakerEpoch: 1 }) }
      ])
    ).toHaveLength(2)
  })

  it('gap markers land in the same place with the same text', () => {
    expect(
      runBoth([
        { kind: 'result', payload: result({ words: words([0, 'before']) }) },
        { kind: 'gap', marker: '[gap: 12s]' },
        { kind: 'result', payload: result({ words: words([0, 'after']) }) }
      ])
    ).toHaveLength(3)
  })

  it('a late rep identification back-fills identically through a splice', () => {
    // The patch here starts at an EARLIER index than the end — the case that
    // breaks any protocol that assumes transcripts only grow at the tail.
    runBoth([
      { kind: 'result', payload: result({ words: words([0, 'one']) }) },
      { kind: 'result', payload: result({ words: words([1, 'two']) }) },
      { kind: 'result', payload: result({ words: words([0, 'three']) }) },
      { kind: 'identifyRep', epoch: 0, speaker: 0 }
    ])
  })

  it('multichannel rep-by-construction', () => {
    runBoth([
      {
        kind: 'result',
        payload: result({ words: words([0, 'rep', 0], [1, 'buyer', 1]), multichannel: true })
      }
    ])
  })

  it('unlabelled turns are never back-filled, on either side', () => {
    runBoth([
      { kind: 'result', payload: result({ words: words([0, 'no labels']), speakerCertain: false }) },
      { kind: 'identifyRep', epoch: 0, speaker: 0 }
    ])
  })

  it('a wordless final carries the current speaker within an epoch', () => {
    runBoth([
      { kind: 'result', payload: result({ words: words([2, 'labelled']) }) },
      { kind: 'result', payload: result({ transcript: 'wordless', words: [] }) }
    ])
  })

  it('an explicit boundary appends where a merge would otherwise happen', () => {
    expect(
      runBoth([
        { kind: 'result', payload: result({ words: words([0, 'mono era']) }) },
        { kind: 'boundary' },
        { kind: 'result', payload: result({ words: words([0, 'after the swap']) }) }
      ])
    ).toHaveLength(2)
  })

  it('interims and no-op identifications change nothing and send nothing', () => {
    const main = new MainThroughTheWire()
    main.ingest(result({ words: words([0, 'real']) }))
    const after = main.patches
    main.ingest(result({ transcript: 'partial', isFinal: false }))
    main.ingest(result({ transcript: '   ', words: [] }))
    // Silence when nothing changed is load-bearing: the renderer re-arms its
    // 5-minute idle-stop clock on every new segments identity, so churning the
    // array would make auto-stop unreachable for the whole call.
    expect(main.patches).toBe(after)
  })

  it('a long realistic call — reconnects, gaps, late identification, a swap', () => {
    const out = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'thanks'], [0, 'for joining']) }) },
      { kind: 'result', payload: result({ words: words([1, 'happy to be here']) }) },
      { kind: 'identifyRep', epoch: 0, speaker: 0 },
      { kind: 'result', payload: result({ words: words([0, 'so about pricing']) }) },
      { kind: 'gap', marker: '[gap: 8s]' },
      { kind: 'result', payload: result({ words: words([1, 'sorry lost you']), speakerEpoch: 1 }) },
      { kind: 'boundary' },
      {
        kind: 'result',
        payload: result({
          words: words([0, 'no problem', 0], [1, 'shall we continue', 1]),
          speakerEpoch: 2,
          multichannel: true
        })
      },
      { kind: 'identifyRep', epoch: 1, speaker: 1 },
      { kind: 'result', payload: result({ transcript: 'tail', words: [], speakerEpoch: 2 }) }
    ])
    expect(out.length).toBeGreaterThan(6)
  })

  it('the two restart orderings the real system produces both agree', () => {
    // Buyer capture off and on used to arm the renderer's boundary on opposite
    // sides of the restart await, so the two copies could disagree about where
    // a turn ended. After 4.3 there is one arming point; both orderings must
    // land in the same place.
    const before = runBoth([
      { kind: 'boundary' },
      { kind: 'result', payload: result({ words: words([0, 'x']) }) }
    ])
    const after = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'x']) }) },
      { kind: 'boundary' }
    ])
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(1)
  })
})
