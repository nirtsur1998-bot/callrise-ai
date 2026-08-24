// M28 P1 — the streaming-markdown split: complete blocks format, the
// trailing (still-growing) block stays plain, fences never leak half-parsed.
import { describe, expect, it } from 'vitest'
import { splitBlocks, tokenizeInline, TABLE_CELL_SEP } from '../markdown-blocks'

describe('splitBlocks — block-progressive streaming', () => {
  it('while streaming, the last unterminated paragraph is trailing, not a block', () => {
    const { blocks, trailing } = splitBlocks('First done.\n\nSecond still typ', false)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'paragraph', lines: ['First done.'] })
    expect(trailing).toBe('Second still typ')
  })

  it('when final, the last block completes and trailing is empty', () => {
    const { blocks, trailing } = splitBlocks('First done.\n\nSecond done.', true)
    expect(blocks).toHaveLength(2)
    expect(trailing).toBe('')
  })

  it('an UNCLOSED code fence is always trailing (never rendered half-parsed)', () => {
    const { blocks, trailing } = splitBlocks('Intro.\n\n```js\nconst x = 1', false)
    expect(blocks).toHaveLength(1)
    expect(trailing).toContain('```js')
  })

  it('a closed fence becomes one code block with its language and body', () => {
    const { blocks } = splitBlocks('```ts\nconst a = 1\nconst b = 2\n```', true)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', meta: 'ts', lines: ['const a = 1', 'const b = 2'] })
  })

  it('headings, bullet lists, ordered lists, quotes all classify', () => {
    const { blocks } = splitBlocks(
      '## Plan\n\n- one\n- two\n\n1. first\n2. second\n\n> a quote line',
      true
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'bullet-list', 'ordered-list', 'quote'])
    expect(blocks[0].meta).toBe('2')
    expect(blocks[1].lines).toEqual(['one', 'two'])
  })
})

describe('tokenizeInline', () => {
  it('code spans win over bold/italic; the rest nests correctly', () => {
    expect(tokenizeInline('mix `**not bold**` with **bold** and *italic* text')).toEqual([
      { type: 'text', text: 'mix ' },
      { type: 'code', text: '**not bold**' },
      { type: 'text', text: ' with ' },
      { type: 'bold', text: 'bold' },
      { type: 'text', text: ' and ' },
      { type: 'italic', text: 'italic' },
      { type: 'text', text: ' text' }
    ])
  })

  it('citation markers pass through untouched as plain text (chips applied later)', () => {
    expect(tokenizeInline('claim [1] here')).toEqual([{ type: 'text', text: 'claim [1] here' }])
  })
})

// AUDIT FIX (2026-08-25) — parseBlock used to classify a whole chunk as ONE
// block, so a heading or list only parsed when it stood ALONE between blank
// lines: the heading arm required `lines.length === 1` and the list arms
// required EVERY line in the chunk to match. Models emit "text, then a
// heading, then bullets" constantly, so `##` and `-` rendered as literal
// characters whenever the model was not tidy. Tables had no block kind at all
// and came out as a wall of pipe characters.
//
// Every case below is a shape a chat model actually produces, written from
// what the renderer would have shown before the fix.
const parsed = (text: string): ReturnType<typeof splitBlocks>['blocks'] =>
  splitBlocks(text, true).blocks

describe('headings and lists WITHOUT a preceding blank line', () => {
  it('a heading that follows a text line in the same chunk', () => {
    const out = parsed('Here is the plan:\n## Step one\nthen we ship.')
    expect(out.map((b) => b.kind)).toEqual(['paragraph', 'heading', 'paragraph'])
    expect(out[1].lines[0]).toBe('Step one')
    expect(out[1].meta).toBe('2')
  })

  it('bullets that follow a text line in the same chunk', () => {
    const out = parsed('Three things:\n- first\n- second')
    expect(out.map((b) => b.kind)).toEqual(['paragraph', 'bullet-list'])
    expect(out[1].lines).toEqual(['first', 'second'])
  })

  it('heading, then bullets, then prose — all one chunk', () => {
    const out = parsed('## Risks\n- pricing\n- timeline\nThat is the shortlist.')
    expect(out.map((b) => b.kind)).toEqual(['heading', 'bullet-list', 'paragraph'])
  })

  it('ordered lists and quotes get the same treatment', () => {
    const out = parsed('Steps:\n1. one\n2. two\n> a note')
    expect(out.map((b) => b.kind)).toEqual(['paragraph', 'ordered-list', 'quote'])
    expect(out[1].lines).toEqual(['one', 'two'])
    expect(out[2].lines).toEqual(['a note'])
  })

  it('a plain multi-line paragraph is still ONE block (no over-splitting)', () => {
    const out = parsed('just a sentence\nand its continuation')
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('paragraph')
    expect(out[0].lines).toEqual(['just a sentence', 'and its continuation'])
  })
})

describe('tables', () => {
  it('parses a GFM table into header and rows', () => {
    const out = parsed('| Client | Stage |\n|---|---|\n| Acme | negotiation |\n| Globex | pilot |')
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('table')
    expect(out[0].meta?.split(TABLE_CELL_SEP)).toEqual(['Client', 'Stage'])
    expect(out[0].lines.map((r) => r.split(TABLE_CELL_SEP))).toEqual([
      ['Acme', 'negotiation'],
      ['Globex', 'pilot']
    ])
  })

  it('handles alignment markers in the delimiter row', () => {
    expect(parsed('| A | B |\n|:--|--:|\n| 1 | 2 |')[0].kind).toBe('table')
  })

  it('a table straight after a text line, no blank line between', () => {
    expect(parsed('Here they are:\n| A | B |\n|---|---|\n| 1 | 2 |').map((b) => b.kind)).toEqual([
      'paragraph',
      'table'
    ])
  })

  it('a pipe in PROSE is not a table — the delimiter row is required', () => {
    // The guard that stops "sales | ops | finance" becoming a table.
    expect(parsed('we split it across sales | ops | finance last year').map((b) => b.kind)).toEqual([
      'paragraph'
    ])
  })

  it('a header with no delimiter row underneath stays prose', () => {
    expect(parsed('| Client | Stage |\n| Acme | negotiation |').every((b) => b.kind === 'paragraph')).toBe(
      true
    )
  })
})

describe('fenced code is never re-scanned', () => {
  it('does not parse headings, bullets or pipes inside a fence', () => {
    const out = parsed('```md\n## not a heading\n- not a bullet\n| a | b |\n|---|---|\n```')
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('code')
    expect(out[0].lines).toEqual(['## not a heading', '- not a bullet', '| a | b |', '|---|---|'])
  })
})
