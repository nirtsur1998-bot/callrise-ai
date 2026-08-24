// M28 P1 — pure block/inline tokenizing for streamed markdown. The approach
// is the block-progressive one streaming chat UIs use (à la Streamdown):
// COMPLETE blocks render as formatted markdown and are memoized by content,
// while the trailing, still-growing block renders as plain text — so the
// layout never reflows behind the reader and only the last block repaints
// per delta. No dependency: the subset below (headings, lists, quotes,
// fenced code, bold/italic/inline-code) covers what a chat model emits.
export interface MdBlock {
  kind: 'paragraph' | 'heading' | 'bullet-list' | 'ordered-list' | 'quote' | 'code' | 'table'
  /** Raw content lines (for lists: one entry per item; for code: body lines;
   *  for tables: one entry per ROW, cells joined by TABLE_CELL_SEP). */
  lines: string[]
  /** Heading level 1-3, code language tag, or — for tables — the header row
   *  with cells joined by TABLE_CELL_SEP. */
  meta?: string
}

/** Cell separator inside a stored table row. NUL cannot survive in text the
 *  model produced and cannot collide with cell content. */
export const TABLE_CELL_SEP = String.fromCharCode(0)

function splitRow(line: string): string[] {
  const t = line.trim()
  const inner = t.startsWith('|') ? t.slice(1) : t
  const body = inner.endsWith('|') ? inner.slice(0, -1) : inner
  return body.split('|').map((c) => c.trim())
}

/** A GFM delimiter row: |---|:--:|---:| and friends. */
function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0
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
  // flatMap: parseBlock now yields one block PER KIND within a chunk.
  return { blocks: rawChunks.flatMap(parseBlock), trailing }
}

/**
 * AUDIT FIX (2026-08-25) — returns MANY blocks, scanning line by line.
 *
 * This used to classify a whole chunk as ONE block, so a heading or a list
 * only parsed when it stood ALONE between blank lines: the heading arm
 * required `lines.length === 1`, and the list arms required EVERY line in the
 * chunk to be a bullet. The extremely common shape
 *
 *     Here is the plan:
 *     ## Step one
 *     - do the thing
 *
 * therefore fell through to 'paragraph' and rendered the `##` and `-` as
 * literal text. Models emit that shape constantly, and a blank line before a
 * heading is a convention they follow inconsistently — so the renderer was
 * correct only when the model happened to be tidy.
 *
 * Now: group CONSECUTIVE lines of the same kind. A chunk yields as many
 * blocks as it contains kinds, and no block's parse depends on what surrounds
 * it. Tables are new — they had no kind at all before and rendered as a wall
 * of pipe characters.
 */
function parseBlock(chunk: string): MdBlock[] {
  const lines = chunk.split('\n')
  const first = lines[0].trim()

  // Fenced code stays whole-chunk: its body is opaque by definition and must
  // never be re-scanned for headings or pipes.
  if (/^```/.test(first)) {
    const body = lines.slice(1)
    if (/^```\s*$/.test((body[body.length - 1] ?? '').trim())) body.pop()
    return [{ kind: 'code', lines: body, meta: first.replace(/^```/, '').trim() }]
  }

  const out: MdBlock[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length > 0) {
      out.push({ kind: 'paragraph', lines: para })
      para = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim())
    if (heading) {
      flushPara()
      out.push({ kind: 'heading', lines: [heading[2]], meta: String(heading[1].length) })
      continue
    }

    // A table needs a header row AND a delimiter row directly beneath it.
    // Without that pair a line containing '|' is just prose — "sales | ops"
    // in a sentence must not become a one-column table.
    if (isTableRow(line) && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      flushPara()
      const header = splitRow(line).join(TABLE_CELL_SEP)
      const rows: string[] = []
      let j = i + 2
      for (; j < lines.length && isTableRow(lines[j]) && !isDelimiterRow(lines[j]); j++) {
        rows.push(splitRow(lines[j]).join(TABLE_CELL_SEP))
      }
      out.push({ kind: 'table', lines: rows, meta: header })
      i = j - 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      let j = i
      for (; j < lines.length && /^\s*[-*]\s+/.test(lines[j]); j++) {
        items.push(lines[j].replace(/^\s*[-*]\s+/, ''))
      }
      out.push({ kind: 'bullet-list', lines: items })
      i = j - 1
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      let j = i
      for (; j < lines.length && /^\s*\d+[.)]\s+/.test(lines[j]); j++) {
        items.push(lines[j].replace(/^\s*\d+[.)]\s+/, ''))
      }
      out.push({ kind: 'ordered-list', lines: items })
      i = j - 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const quoted: string[] = []
      let j = i
      for (; j < lines.length && /^\s*>\s?/.test(lines[j]); j++) {
        quoted.push(lines[j].replace(/^\s*>\s?/, ''))
      }
      out.push({ kind: 'quote', lines: quoted })
      i = j - 1
      continue
    }

    para.push(line)
  }
  flushPara()
  return out.length > 0 ? out : [{ kind: 'paragraph', lines }]
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
