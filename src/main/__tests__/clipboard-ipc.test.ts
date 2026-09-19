// BUG-288 — copying, from main, because the renderer cannot.
//
// The founder pressed the new Copy button and pasted nothing. Measured in the
// running app straight after, both renderer APIs:
//   navigator.clipboard.writeText -> NotAllowedError: Write permission denied
//   navigator.clipboard.write     -> NotAllowedError: Write permission denied
// The renderer is a file:// document and index.ts's permission handler grants
// `media` and nothing else, so the Async Clipboard API has never worked here —
// which also means CallDetail's "Copy transcript" never worked.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeClipboardPayload } from '../clipboard-ipc'

describe('sanitizeClipboardPayload — the renderer is the untrusted side', () => {
  it('keeps text and html together', () => {
    expect(sanitizeClipboardPayload({ text: 'a', html: '<p>a</p>' })).toEqual({
      text: 'a',
      html: '<p>a</p>'
    })
  })

  it('a text-only copy is fine — html is optional', () => {
    expect(sanitizeClipboardPayload({ text: 'a' })).toEqual({ text: 'a' })
  })

  it('refuses an empty or whitespace-only copy rather than clearing the clipboard', () => {
    expect(sanitizeClipboardPayload({ text: '' })).toBeNull()
    expect(sanitizeClipboardPayload({ text: '   \n ' })).toBeNull()
  })

  it('refuses junk instead of letting clipboard.write throw', () => {
    expect(sanitizeClipboardPayload(null)).toBeNull()
    expect(sanitizeClipboardPayload('text')).toBeNull()
    expect(sanitizeClipboardPayload({ text: 42 })).toBeNull()
  })

  it('drops a blank html flavour rather than writing an empty rich copy', () => {
    expect(sanitizeClipboardPayload({ text: 'a', html: '   ' })).toEqual({ text: 'a' })
    expect(sanitizeClipboardPayload({ text: 'a', html: 5 })).toEqual({ text: 'a' })
  })
})

describe('nothing in the renderer still calls the API that does not work', () => {
  const read = (...p: string[]): string =>
    readFileSync(join(__dirname, '..', '..', 'renderer', 'src', ...p), 'utf8')

  /** Comments stripped: every one of these files EXPLAINS the broken API in
   *  prose, and a pin that matched prose would fail on its own documentation
   *  (which it did, first run). */
  const code = (...p: string[]): string =>
    read(...p)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

  it('the three known callers go through main', () => {
    for (const path of [
      ['features', 'calls', 'CallDetail.tsx'],
      ['features', 'alerts', 'ChannelsCard.tsx'],
      ['features', 'contacts', 'crmNoteFormat.ts']
    ] as const) {
      const src = code(...path)
      expect(src, `${path.join('/')} must not use navigator.clipboard`).not.toContain(
        'navigator.clipboard'
      )
      expect(src, `${path.join('/')} copies through main`).toContain('api.clipboard.write')
    }
  })

  it('the handler is actually registered — an IPC nobody registers is the same bug again', () => {
    const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
    expect(index).toContain('registerClipboardIpc()')
    expect(index).toContain("from './clipboard-ipc'")
  })
})
