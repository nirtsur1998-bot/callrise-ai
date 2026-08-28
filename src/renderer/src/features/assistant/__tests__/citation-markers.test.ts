// Audit fix V4 — chips bind by marker id, never by position. The founder's
// required red-check lives here: inject a bogus marker and prove every
// remaining chip still points at its own memory.
import { describe, expect, it } from 'vitest'
import { segmentCitedText, type CitationLike } from '../citation-markers'

const cits: CitationLike[] = [
  { kind: 'memory', id: 'mem-1', label: 'one', marker: 1 },
  { kind: 'memory', id: 'mem-3', label: 'three', marker: 3 }
]

function chips(text: string, citations: CitationLike[] = cits): { marker: number; id: string }[] {
  return segmentCitedText(text, citations).flatMap((s) =>
    s.type === 'chip' ? [{ marker: s.marker, id: s.citation.id }] : []
  )
}

describe('segmentCitedText — binding is by marker id, never position', () => {
  it('THE red-check scenario: a model-invented [7] cannot shift the real chips', () => {
    // Old positional mapping would have bound [7]->mem-1 and [1]->mem-3.
    const result = chips('Bogus [7] then real [1] and [3].')
    expect(result).toEqual([
      { marker: 1, id: 'mem-1' },
      { marker: 3, id: 'mem-3' }
    ])
    // And the bogus marker survives as harmless plain text.
    const texts = segmentCitedText('Bogus [7] then real [1] and [3].', cits)
      .filter((s) => s.type === 'text')
      .map((s) => (s as { text: string }).text)
    expect(texts.join('')).toContain('[7]')
  })

  it('out-of-order and repeated markers bind correctly every time', () => {
    expect(chips('[3] first, then [1], then [3] again')).toEqual([
      { marker: 3, id: 'mem-3' },
      { marker: 1, id: 'mem-1' },
      { marker: 3, id: 'mem-3' }
    ])
  })

  it('citations without a marker (legacy rows) never produce chips', () => {
    const legacy = [{ kind: 'memory' as const, id: 'old', label: 'x' }]
    expect(chips('claim [1]', legacy)).toEqual([])
  })

  it('no citations → everything is plain text, including bracket-looking tokens', () => {
    const segs = segmentCitedText('array[1] indexing talk', undefined)
    expect(segs.every((s) => s.type === 'text')).toBe(true)
  })
})
