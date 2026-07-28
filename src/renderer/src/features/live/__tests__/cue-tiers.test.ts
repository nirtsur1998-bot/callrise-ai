import { describe, expect, it } from 'vitest'
import { tierFor, type CueKind } from '../useLiveCues'

// §4.3's whole point, as an executable rule rather than a convention: an
// LLM-generated cue must never be able to reach the interrupt channel.
//
// The tier is DERIVED from the kind rather than passed alongside it, so there
// is no call site that can get this wrong — which is why this test is about
// the classification rather than about the emit path.

const MODEL_KINDS: CueKind[] = ['objection', 'discovery', 'next-question', 'buying-signal']

describe('tierFor', () => {
  it('lets the deterministic pace cue interrupt', () => {
    expect(tierFor('pace')).toBe('interrupt')
  })

  it.each(MODEL_KINDS)('keeps the model-generated %s cue off the interrupt path', (kind) => {
    expect(tierFor(kind)).toBe('suggestion')
  })

  // A new cue kind is a suggestion until someone deliberately promotes it,
  // because the failure of guessing wrong in that direction is an
  // interruption the rep did not earn.
  it('defaults an unrecognised kind to the side rail', () => {
    expect(tierFor('something-new' as CueKind)).toBe('suggestion')
  })

  it('classifies every kind exactly one way', () => {
    const all: CueKind[] = ['pace', ...MODEL_KINDS]
    for (const kind of all) {
      expect(['interrupt', 'suggestion']).toContain(tierFor(kind))
    }
    // Exactly one kind may interrupt today. If this number changes, it should
    // be because someone added a genuinely deterministic trigger — not because
    // a model cue drifted across the line.
    expect(all.filter((k) => tierFor(k) === 'interrupt')).toEqual(['pace'])
  })
})
