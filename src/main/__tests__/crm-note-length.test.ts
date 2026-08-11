import { describe, expect, it } from 'vitest'
import {
  CRM_NOTE_LENGTHS,
  sanitizeCrmNoteLength,
  crmNoteLengthClause,
  crmNoteMaxTokens
} from '../crm-note-length'

describe('sanitizeCrmNoteLength', () => {
  it('accepts every valid length', () => {
    for (const length of CRM_NOTE_LENGTHS) {
      expect(sanitizeCrmNoteLength(length)).toBe(length)
    }
  })

  it('defaults to medium for anything invalid', () => {
    expect(sanitizeCrmNoteLength('extra-long')).toBe('medium')
    expect(sanitizeCrmNoteLength(undefined)).toBe('medium')
    expect(sanitizeCrmNoteLength(null)).toBe('medium')
    expect(sanitizeCrmNoteLength(42)).toBe('medium')
    expect(sanitizeCrmNoteLength({})).toBe('medium')
  })
})

describe('crmNoteLengthClause', () => {
  it('produces a distinct clause per length', () => {
    const clauses = CRM_NOTE_LENGTHS.map(crmNoteLengthClause)
    expect(new Set(clauses).size).toBe(clauses.length)
  })

  it('medium matches the original always-2-3-sentences behavior', () => {
    expect(crmNoteLengthClause('medium')).toContain('2-3 sentences')
  })
})

describe('crmNoteMaxTokens', () => {
  it('medium matches crm-notes.ts\'s original fixed budget (512)', () => {
    expect(crmNoteMaxTokens('medium')).toBe(512)
  })

  it('detailed gets more headroom than medium, short gets less', () => {
    expect(crmNoteMaxTokens('short')).toBeLessThan(crmNoteMaxTokens('medium'))
    expect(crmNoteMaxTokens('detailed')).toBeGreaterThan(crmNoteMaxTokens('medium'))
  })
})
