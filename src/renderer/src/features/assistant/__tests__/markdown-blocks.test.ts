// M28 P1 — the streaming-markdown split: complete blocks format, the
// trailing (still-growing) block stays plain, fences never leak half-parsed.
import { describe, expect, it } from 'vitest'
import { splitBlocks, tokenizeInline } from '../markdown-blocks'

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
