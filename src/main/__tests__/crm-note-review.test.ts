// The bug these exist for: "Generate CRM note" makes TWO AI calls and hands
// back two things the rep reviews separately — a drafted note and a list of
// suggested contact-field updates. Both used to live only in the card's
// React state, so navigating off the Contact page permanently discarded
// whatever hadn't been dealt with yet, already paid for. The job now holds
// the output AND the rep's decisions; this module owns the arithmetic that
// makes a reopen resume correctly.
import { describe, expect, it } from 'vitest'
import {
  asCrmNoteJobResult,
  isFullyReviewed,
  pendingFacts,
  skippedFacts,
  withDecision,
  type CrmNoteJobResult
} from '../crm-note-review'
import type { KycFact } from '../crm-note-generator'

function fact(id: string, field = 'timeline', text = 'Q1'): KycFact {
  return { id, field, text, confidence: 'high' }
}

function result(overrides: Partial<CrmNoteJobResult> = {}): CrmNoteJobResult {
  return { note: 'Drafted note.', facts: [fact('f1'), fact('f2'), fact('f3')], ...overrides }
}

describe('asCrmNoteJobResult', () => {
  it('accepts a well-formed result (the shape that round-trips through disk/IPC)', () => {
    expect(asCrmNoteJobResult({ note: 'n', facts: [] })).toEqual({ note: 'n', facts: [] })
  })

  it('rejects anything that is not one, rather than half-rendering a broken card', () => {
    expect(asCrmNoteJobResult(null)).toBeNull()
    expect(asCrmNoteJobResult(undefined)).toBeNull()
    expect(asCrmNoteJobResult('a string')).toBeNull()
    expect(asCrmNoteJobResult({ note: 'n' })).toBeNull() // no facts array
    expect(asCrmNoteJobResult({ facts: [] })).toBeNull() // no note
  })
})

describe('pendingFacts — what the rep still has to look at', () => {
  it('starts as every harvested fact', () => {
    expect(pendingFacts(result()).map((f) => f.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('drops an accepted fact', () => {
    const r = withDecision(result(), { kind: 'fact-accepted', factId: 'f2' })
    expect(pendingFacts(r).map((f) => f.id)).toEqual(['f1', 'f3'])
  })

  it('drops a skipped fact', () => {
    const r = withDecision(result(), { kind: 'fact-skipped', factId: 'f1' })
    expect(pendingFacts(r).map((f) => f.id)).toEqual(['f2', 'f3'])
  })

  it('a skipped fact stays skipped — reapplying the same decision is idempotent, and it never returns to pending', () => {
    let r = withDecision(result(), { kind: 'fact-skipped', factId: 'f1' })
    r = withDecision(r, { kind: 'fact-skipped', factId: 'f1' })
    expect(r.review?.skipped).toEqual(['f1']) // not duplicated
    expect(pendingFacts(r).map((f) => f.id)).toEqual(['f2', 'f3'])
  })
})

describe('skippedFacts — a mis-click must leave a trace', () => {
  it('is empty when nothing was skipped', () => {
    expect(skippedFacts(result())).toEqual([])
  })

  it('lists exactly the skipped ones, so the card can surface them instead of losing them silently', () => {
    let r = withDecision(result(), { kind: 'fact-skipped', factId: 'f1' })
    r = withDecision(r, { kind: 'fact-skipped', factId: 'f3' })
    expect(skippedFacts(r).map((f) => f.id)).toEqual(['f1', 'f3'])
  })

  it('does not list an accepted fact as skipped', () => {
    const r = withDecision(result(), { kind: 'fact-accepted', factId: 'f1' })
    expect(skippedFacts(r)).toEqual([])
  })
})

describe('isFullyReviewed — when it is safe to dismiss the job', () => {
  it('is false on a fresh result (nothing reviewed at all)', () => {
    expect(isFullyReviewed(result())).toBe(false)
  })

  it('is false when the note is handled but suggestions are still pending — the job still holds unreviewed paid-for output', () => {
    const r = withDecision(result(), { kind: 'note-handled' })
    expect(isFullyReviewed(r)).toBe(false)
  })

  it('is false when every suggestion is decided but the note is not', () => {
    let r = result()
    for (const id of ['f1', 'f2', 'f3']) {
      r = withDecision(r, { kind: 'fact-accepted', factId: id })
    }
    expect(isFullyReviewed(r)).toBe(false)
  })

  it('is true only once the note is handled AND every suggestion is decided', () => {
    let r = withDecision(result(), { kind: 'note-handled' })
    r = withDecision(r, { kind: 'fact-accepted', factId: 'f1' })
    r = withDecision(r, { kind: 'fact-skipped', factId: 'f2' })
    expect(isFullyReviewed(r)).toBe(false)
    r = withDecision(r, { kind: 'fact-skipped', factId: 'f3' })
    expect(isFullyReviewed(r)).toBe(true)
  })

  it('a draft with no suggestions at all is fully reviewed as soon as the note is handled', () => {
    const r = withDecision(result({ facts: [] }), { kind: 'note-handled' })
    expect(isFullyReviewed(r)).toBe(true)
  })
})

describe('withDecision — never mutates', () => {
  it('leaves the original result untouched', () => {
    const original = result()
    const next = withDecision(original, { kind: 'fact-skipped', factId: 'f1' })
    expect(original.review).toBeUndefined()
    expect(next.review?.skipped).toEqual(['f1'])
    expect(next.facts).toBe(original.facts) // the AI output itself is shared, not copied
  })

  it('preserves earlier decisions when adding a new one', () => {
    let r = withDecision(result(), { kind: 'note-handled' })
    r = withDecision(r, { kind: 'fact-accepted', factId: 'f1' })
    r = withDecision(r, { kind: 'fact-skipped', factId: 'f2' })
    expect(r.review).toEqual({ noteHandled: true, accepted: ['f1'], skipped: ['f2'] })
  })
})
