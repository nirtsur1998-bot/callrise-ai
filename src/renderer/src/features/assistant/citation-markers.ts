// Audit fix V4 — pure marker→citation binding for rendered replies.
// Binding is BY MARKER NUMBER carried on each persisted citation, never by
// array position: a marker the model invented (no citation carries that
// number) renders as plain text and cannot shift any other chip onto the
// wrong evidence. Kept pure (no React) so the invariant is directly
// unit-tested, including the deliberate bogus-marker injection.
export interface CitationLike {
  kind: 'memory' | 'call'
  id: string
  label: string
  marker?: number
}

export type CitedSegment<C extends CitationLike> =
  | { type: 'text'; text: string }
  | { type: 'chip'; marker: number; citation: C }

const MARKER_RE = /(\[\d{1,2}\])/g

export function segmentCitedText<C extends CitationLike>(
  text: string,
  citations: C[] | undefined
): CitedSegment<C>[] {
  const byMarker = new Map<number, C>()
  for (const c of citations ?? []) {
    if (typeof c.marker === 'number') byMarker.set(c.marker, c)
  }
  const segments: CitedSegment<C>[] = []
  for (const part of text.split(MARKER_RE)) {
    if (part === '') continue
    const match = /^\[(\d{1,2})\]$/.exec(part)
    const citation = match ? byMarker.get(Number(match[1])) : undefined
    if (match && citation) {
      segments.push({ type: 'chip', marker: Number(match[1]), citation })
    } else {
      segments.push({ type: 'text', text: part })
    }
  }
  return segments
}
