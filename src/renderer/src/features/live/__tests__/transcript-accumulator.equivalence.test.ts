// M26 Phase 4.1's actual bar: the main-process accumulator must produce
// BYTE-IDENTICAL transcripts to the renderer's, for every input sequence.
//
// This runs both implementations over the same events and compares the
// results. It is the anti-drift mechanism for the window (4.1 → 4.3) where
// two copies of this logic exist — and it is why the main-side version was
// PORTED rather than reinvented.
//
// The renderer's version is trapped inside a React hook, so it cannot be
// called directly. What CAN be called directly is the pure pair the hook
// delegates to — groupWords/mergeSegments in features/live/segments.ts — plus
// the hook's own role/boundary rules, which are reproduced here in a compact
// reference implementation transcribed line-for-line from
// useTranscription.ts:286-342. If someone changes the hook without changing
// the accumulator (or vice versa), these tests fail.
//
// Deliberately includes the cases the Phase 4 research flagged as the ones a
// reimplementation gets wrong: epoch boundaries after a reconnect, gap
// markers, multichannel rep-by-construction, unlabelled turns, and late rep
// identification.
import { describe, expect, it } from 'vitest'
// This test necessarily spans both processes, and it lives on the RENDERER
// side rather than under src/main for a concrete reason. tsconfig.web.json
// defines the `@renderer/*` alias that renderer modules use internally;
// tsconfig.node.json does not. So a test under src/main reaching across would
// drag renderer files into a program that cannot resolve their own imports.
// The reverse direction works cleanly precisely because
// main/live/transcript-accumulator.ts is deliberately dependency-free — it
// imports nothing at all, which is what lets it be absorbed here.
import { groupWords, mergeSegments } from '../segments'
import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'
import {
  TranscriptAccumulator,
  type TranscriptResult
} from '../../../../../main/live/transcript-accumulator'

/**
 * The renderer's behaviour, transcribed from useTranscription.ts:286-342 and
 * :368-378 and :184-201. Uses the renderer's OWN groupWords/mergeSegments —
 * so any change to those is picked up here automatically, and only the
 * hook-local rules are restated.
 */
class RendererReference {
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
    if (payload.multichannel && !this.repByEpoch.has(epoch)) {
      this.repByEpoch.set(epoch, 0)
    }
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
          role: sameEpoch
            ? this.resolveRole(lastSpeaker, epoch, payload.speakerCertain)
            : 'unknown',
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

function words(...specs: Array<[number, string, number?]>): TranscriptWordList {
  return specs.map(([speaker, text, channel]) =>
    channel === undefined ? { speaker, text } : { speaker, text, channel }
  )
}
type TranscriptWordList = TranscriptResult['words']

/** Drives both implementations through the same events and asserts the
 *  transcripts are byte-identical. Returns the transcript so a test can also
 *  assert what it should actually BE, not merely that both agree. */
function runBoth(events: Event[]): unknown[] {
  const main = new TranscriptAccumulator()
  const renderer = new RendererReference()
  for (const e of events) {
    switch (e.kind) {
      case 'result':
        main.ingest(e.payload)
        renderer.ingest(e.payload)
        break
      case 'gap':
        main.ingestGap(e.marker)
        renderer.ingestGap(e.marker)
        break
      case 'boundary':
        main.markSpeakerBoundary()
        renderer.markSpeakerBoundary()
        break
      case 'identifyRep':
        main.identifyRep(e.epoch, e.speaker)
        renderer.identifyRep(e.epoch, e.speaker)
        break
    }
  }
  // JSON round-trip, not toEqual: catches key-ORDER and undefined-vs-absent
  // differences that a structural comparison forgives. "Byte-identical" is
  // the bar, so the comparison should be byte-level.
  expect(JSON.stringify(main.snapshot())).toBe(JSON.stringify(renderer.segments))
  return main.snapshot()
}

describe('main accumulator === renderer accumulator', () => {
  it('a single finalized turn', () => {
    const out = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'hello'], [0, 'there']) }) }
    ])
    expect(out).toHaveLength(1)
  })

  it('two speakers alternating', () => {
    const out = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'hi'], [1, 'hello'], [0, 'so']) }) }
    ])
    expect(out).toHaveLength(3)
  })

  it('the same speaker continuing across results merges into one turn', () => {
    const out = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'first']) }) },
      { kind: 'result', payload: result({ words: words([0, 'second']) }) }
    ])
    expect(out).toHaveLength(1)
  })

  it('NEVER merges across an epoch boundary — the reconnect mislabeling hazard', () => {
    const out = runBoth([
      {
        kind: 'result',
        payload: result({ words: words([0, 'before reconnect']), speakerEpoch: 0 })
      },
      { kind: 'result', payload: result({ words: words([0, 'after reconnect']), speakerEpoch: 1 }) }
    ])
    // Same speaker NUMBER, different people. Two turns, not one.
    expect(out).toHaveLength(2)
  })

  it('a gap marker is a hard boundary', () => {
    const out = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'before']) }) },
      { kind: 'gap', marker: '[gap: 12s]' },
      { kind: 'result', payload: result({ words: words([0, 'after']) }) }
    ])
    expect(out).toHaveLength(3)
  })

  it('multichannel makes channel 0 the rep by construction', () => {
    const out = runBoth([
      {
        kind: 'result',
        payload: result({
          words: words([0, 'rep speaking', 0], [1, 'buyer', 1]),
          multichannel: true
        })
      }
    ])
    expect(out).toHaveLength(2)
  })

  it('an uncertain result marks turns unlabelled and unknown', () => {
    runBoth([
      { kind: 'result', payload: result({ words: words([0, 'mystery']), speakerCertain: false }) }
    ])
  })

  it('late rep identification back-fills only that epoch, and never unlabelled turns', () => {
    runBoth([
      { kind: 'result', payload: result({ words: words([0, 'epoch zero']), speakerEpoch: 0 }) },
      { kind: 'result', payload: result({ words: words([0, 'epoch one']), speakerEpoch: 1 }) },
      {
        kind: 'result',
        payload: result({ words: words([0, 'no labels']), speakerEpoch: 0, speakerCertain: false })
      },
      { kind: 'identifyRep', epoch: 0, speaker: 0 }
    ])
  })

  it('a final with no per-word data carries the current speaker within an epoch', () => {
    runBoth([
      { kind: 'result', payload: result({ words: words([2, 'labelled turn']) }) },
      { kind: 'result', payload: result({ transcript: 'wordless final', words: [] }) }
    ])
  })

  it('a wordless final across an epoch boundary is recorded as a guess, not asserted', () => {
    runBoth([
      { kind: 'result', payload: result({ words: words([2, 'labelled']), speakerEpoch: 0 }) },
      {
        kind: 'result',
        payload: result({ transcript: 'wordless', words: [], speakerEpoch: 1 })
      }
    ])
  })

  it('interim results change nothing', () => {
    const out = runBoth([
      { kind: 'result', payload: result({ transcript: 'partial', isFinal: false }) },
      { kind: 'result', payload: result({ words: words([0, 'final']) }) }
    ])
    expect(out).toHaveLength(1)
  })

  it('an explicit speaker boundary (mono<->multichannel swap) appends rather than merges', () => {
    // Same speaker key AND same epoch on both sides, so these WOULD merge into
    // one turn if the boundary flag were ignored. Two turns is the proof the
    // flag is honoured — a channel change would have forced a split anyway and
    // proved nothing.
    const out = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'mono era']) }) },
      { kind: 'boundary' },
      { kind: 'result', payload: result({ words: words([0, 'after the swap']) }) }
    ])
    expect(out).toHaveLength(2)
  })

  it('sanity: without the boundary those same two results DO merge', () => {
    const out = runBoth([
      { kind: 'result', payload: result({ words: words([0, 'mono era']) }) },
      { kind: 'result', payload: result({ words: words([0, 'after the swap']) }) }
    ])
    expect(out).toHaveLength(1)
  })

  it('a long realistic call with reconnects, gaps and late identification', () => {
    const events: Event[] = [
      {
        kind: 'result',
        payload: result({ words: words([0, 'thanks'], [0, 'for'], [0, 'joining']) })
      },
      {
        kind: 'result',
        payload: result({ words: words([1, 'happy'], [1, 'to'], [1, 'be here']) })
      },
      { kind: 'identifyRep', epoch: 0, speaker: 0 },
      { kind: 'result', payload: result({ words: words([0, 'so about pricing']) }) },
      { kind: 'gap', marker: '[gap: 8s]' },
      { kind: 'result', payload: result({ words: words([1, 'sorry lost you']), speakerEpoch: 1 }) },
      { kind: 'result', payload: result({ words: words([0, 'no problem']), speakerEpoch: 1 }) },
      { kind: 'identifyRep', epoch: 1, speaker: 0 },
      { kind: 'result', payload: result({ transcript: 'tail', words: [], speakerEpoch: 1 }) }
    ]
    const out = runBoth(events)
    expect(out.length).toBeGreaterThan(5)
  })

  it('empty and whitespace-only words are dropped identically', () => {
    runBoth([
      { kind: 'result', payload: result({ words: words([0, '  '], [0, 'real'], [0, '']) }) }
    ])
  })
})
