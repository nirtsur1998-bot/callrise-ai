// M28 P1 — pure block/inline tokenizing for streamed markdown. The approach
// is the block-progressive one streaming chat UIs use (à la Streamdown):
// COMPLETE blocks render as formatted markdown and are memoized by content,
// while the trailing, still-growing block renders as plain text — so the
// layout never reflows behind the reader and only the last block repaints
// per delta. No dependency: the subset below (headings, lists, quotes,
// fenced code, bold/italic/inline-code) covers what a chat model emits.
export interface MdBlock {
  kind: 'paragraph' | 'heading' | 'bullet-list' | 'ordered-list' | 'quote' | 'code'
  /** Raw content lines (for lists: one entry per item; for code: body lines). */
  lines: string[]
  /** Heading level 1-3, code language tag. */
  meta?: string
}

/** Split into complete blocks + the trailing (possibly still streaming)
 *  remainder. Fence-aware: an UNCLOSED ``` fence is always trailing. When
 *  `final` is true there is no trailing — the last block completes. */
export function splitBlocks(
  text: string,
  final: boolean
): { blocks: MdBlock[]; trailing: string } {
  const rawChunks: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line.trim())) {
      if (!inFence) {
        if (current.length > 0 && current.some((l) => l.trim() !== '')) {
          rawChunks.push(current.join('\n'))
        }
        current = [line]
        inFence = true
      } else {
        current.push(line)
        rawChunks.push(current.join('\n'))
        current = []
        inFence = false
      }
      continue
    }
    if (!inFence && line.trim() === '') {
      if (current.length > 0) rawChunks.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  let trailing = ''
  if (current.length > 0) {
    if (final) rawChunks.push(current.join('\n'))
    else trailing = current.join('\n')
  }
  return { blocks: rawChunks.map(parseBlock), trailing }
}

function parseBlock(chunk: string): MdBlock {
  const lines = chunk.split('\n')
  const first = lines[0].trim()
  if (/^```/.test(first)) {
    const body = lines.slice(1)
    if (/^```\s*$/.test((body[body.length - 1] ?? '').trim())) body.pop()
    return { kind: 'code', lines: body, meta: first.replace(/^```/, '').trim() }
  }
  const heading = /^(#{1,3})\s+(.*)$/.exec(first)
  if (heading && lines.length === 1) {
    return { kind: 'heading', lines: [heading[2]], meta: String(heading[1].length) }
  }
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    return { kind: 'bullet-list', lines: lines.map((l) => l.replace(/^\s*[-*]\s+/, '')) }
  }
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    return { kind: 'ordered-list', lines: lines.map((l) => l.replace(/^\s*\d+[.)]\s+/, '')) }
  }
  if (lines.every((l) => /^\s*>\s?/.test(l))) {
    return { kind: 'quote', lines: lines.map((l) => l.replace(/^\s*>\s?/, '')) }
  }
  return { kind: 'paragraph', lines }
}

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }

/** Inline formatting for one text run: `code` spans win, then **bold**, then
 *  *italic*. Citation markers are NOT handled here — the component applies
 *  segmentCitedText to the plain-text tokens afterwards, so chips and
 *  formatting compose without either parser knowing about the other. */
export function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = []
  const codeSplit = text.split(/(`[^`\n]+`)/g)
  for (const part of codeSplit) {
    if (part === '') continue
    const code = /^`([^`\n]+)`$/.exec(part)
    if (code) {
      out.push({ type: 'code', text: code[1] })
      continue
    }
    for (const piece of part.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g)) {
      if (piece === '') continue
      const bold = /^\*\*([^*\n]+)\*\*$/.exec(piece)
      const italic = /^\*([^*\n]+)\*$/.exec(piece)
      if (bold) out.push({ type: 'bold', text: bold[1] })
      else if (italic) out.push({ type: 'italic', text: italic[1] })
      else out.push({ type: 'text', text: piece })
    }
  }
  return out
}
