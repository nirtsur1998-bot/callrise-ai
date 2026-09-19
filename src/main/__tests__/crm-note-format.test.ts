// The founder's complaint, 2026-09-18: "when you copy and paste it it comes as
// one long row on a different CRM."
//
// Nothing was lost in transit — the note was GENERATED as one paragraph
// (crm-note-length.ts asks for "2-3 sentences"), so there were no line breaks
// for the other CRM to keep. These tests are about the thing that fixes that:
// a note with parts, rendered so the parts survive a paste.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CRM_NOTE_SECTIONS,
  formatCrmNoteText,
  isPlainNote,
  legacySections,
  sanitizeSections,
  type CrmNoteSections
} from '../crm-note-format'

const full: CrmNoteSections = {
  summary: 'Reviewed the portfolio and agreed to price the top-up.',
  discussed: ['Current allocation is 60/40', 'Wants exposure to AU equities'],
  concerns: ['Worried about the exit fee'],
  status: 'Verbal yes, waiting on paperwork.',
  nextSteps: ['Send the fee breakdown Monday', 'Book the signing call']
}

describe('the plain-text note — the one that gets pasted', () => {
  const text = formatCrmNoteText(full, { contactName: 'Harvey', callDate: '17 Sep 2026' })

  it('is NOT one long row: blocks are separated by blank lines', () => {
    expect(text).toContain('\n\n')
    expect(text.split('\n').length).toBeGreaterThan(8)
  })

  it('names itself, so a pasted note means something in a CRM that has never heard of us', () => {
    expect(text.startsWith('Call with Harvey · 17 Sep 2026')).toBe(true)
  })

  it('gives every list item its own line with a bullet', () => {
    expect(text).toContain('Discussed:\n• Current allocation is 60/40\n• Wants exposure to AU equities')
    expect(text).toContain('• Send the fee breakdown Monday')
  })

  it('labels a single-line section inline rather than making a one-item list', () => {
    expect(text).toContain('Where it stands: Verbal yes, waiting on paperwork.')
  })

  it('keeps the buyer’s own words and the owner/date on a next step', () => {
    // The two things the research is loudest about: a quantified need loses
    // its point when paraphrased, and an action item with no owner gets missed.
    const t = formatCrmNoteText({
      summary: 'Agreed to pilot.',
      needs: ['"it takes my team an hour a day just in updates"'],
      stakeholders: ['Sarah (CFO) signs off'],
      nextSteps: ['Rep sends the pilot scope Monday']
    })
    expect(t).toContain('What they need:\n• "it takes my team an hour a day just in updates"')
    expect(t).toContain("Who's involved:\n• Sarah (CFO) signs off")
    expect(t).toContain('Next steps:\n• Rep sends the pilot scope Monday')
  })

  it('omits sections the call did not supply — no empty headings', () => {
    const thin = formatCrmNoteText({ summary: 'Left a voicemail.' })
    expect(thin).toBe('Left a voicemail.')
    for (const [, label] of CRM_NOTE_SECTIONS) expect(thin).not.toContain(label)
  })

  it('a header with no date still reads', () => {
    expect(formatCrmNoteText({ summary: 'x' }, { contactName: 'Harvey' })).toBe(
      'Call with Harvey\n\nx'
    )
  })
})

describe('sanitizeSections — the model is not trusted', () => {
  it('drops a note with no summary, whatever else it returned', () => {
    expect(sanitizeSections({ discussed: ['a'] })).toBeNull()
    expect(sanitizeSections({ summary: '   ' })).toBeNull()
    expect(sanitizeSections(null)).toBeNull()
    expect(sanitizeSections('a note')).toBeNull()
  })

  it('keeps a summary-only note — the BUG-241 lesson: optional means optional', () => {
    expect(sanitizeSections({ summary: 'Just this.' })).toEqual({ summary: 'Just this.' })
  })

  it('throws away blanks and non-strings inside a list rather than rendering them', () => {
    const s = sanitizeSections({ summary: 's', nextSteps: ['a', '', '   ', 42, null, 'b'] })
    expect(s?.nextSteps).toEqual(['a', 'b'])
  })

  it('drops a list that is not a list, instead of crashing the card', () => {
    expect(sanitizeSections({ summary: 's', discussed: 'not an array' })?.discussed).toBeUndefined()
  })

  it('caps a runaway list', () => {
    const s = sanitizeSections({ summary: 's', discussed: Array.from({ length: 40 }, (_, i) => `i${i}`) })
    expect(s?.discussed).toHaveLength(8)
  })
})

describe('a note from before this existed still renders', () => {
  it('legacySections turns the old paragraph into a summary-only note', () => {
    const old = legacySections('  One long paragraph, exactly as it was.  ')
    expect(old).toEqual({ summary: 'One long paragraph, exactly as it was.' })
    expect(isPlainNote(old)).toBe(true)
    expect(formatCrmNoteText(old)).toBe('One long paragraph, exactly as it was.')
  })

  it('isPlainNote is false as soon as there is any structure', () => {
    expect(isPlainNote(full)).toBe(false)
    expect(isPlainNote({ summary: 's', status: 'x' })).toBe(false)
  })
})

describe('the renderer copy of the section list cannot drift', () => {
  // The renderer cannot import from src/main (tsconfig.web.json's scope), so
  // crmNoteFormat.ts repeats this list — the same constraint tier1-types.ts
  // and holdsUnreviewedOutput.ts already live with. If the two ever disagree,
  // the card would render headings the copied text does not have.
  it('matches CRM_NOTE_SECTIONS in the renderer, key for key and label for label', () => {
    const rendererSrc = readFileSync(
      join(__dirname, '..', '..', 'renderer', 'src', 'features', 'contacts', 'crmNoteFormat.ts'),
      'utf8'
    )
    const block = rendererSrc.slice(
      rendererSrc.indexOf('CRM_NOTE_SECTIONS'),
      rendererSrc.indexOf('] as const')
    )
    // Both quote styles: a label with an apostrophe ("Who's involved") has to
    // be written with double quotes, and a single-quote-only pattern silently
    // skipped that row — which is how this pin nearly passed while the two
    // lists disagreed.
    const pairs = [...block.matchAll(/\[\s*'(\w+)',\s*(?:'([^']+)'|"([^"]+)")\s*\]/g)].map((m) => [
      m[1],
      m[2] ?? m[3]
    ])
    expect(pairs).toEqual(CRM_NOTE_SECTIONS.map(([k, l]) => [k, l]))
  })
})
