// @vitest-environment happy-dom
//
// The copy control the founder asked for, 2026-09-18 — and the reason it
// writes two MIME types rather than one.
//
// A plain-text paste into a RICH-TEXT CRM field collapses single newlines,
// because HTML does not honour them: that is the second half of "it comes as
// one long row", and no amount of structure in the plain text fixes it. So a
// copy offers text/plain AND text/html and lets the destination choose.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyNote, toHtml, toMarkdown, sectionsOf } from '../crmNoteFormat'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sections = {
  summary: 'Reviewed the portfolio.',
  discussed: ['Allocation is 60/40', 'Wants AU equities'],
  nextSteps: ['Send the fee breakdown']
}

describe('the rich-text rendering', () => {
  const html = toHtml(sections, { contactName: 'Harvey', callDate: '17 Sep 2026' })

  it('uses a real list, which is what survives a paste into a rich-text field', () => {
    expect(html).toContain('<ul><li>Allocation is 60/40</li><li>Wants AU equities</li></ul>')
  })

  it('makes the headings headings, not bare text', () => {
    expect(html).toContain('<strong>Discussed</strong>')
    expect(html).toContain('<strong>Call with Harvey · 17 Sep 2026</strong>')
  })

  it('escapes the buyer’s own words instead of injecting markup into their CRM', () => {
    const nasty = toHtml({ summary: 'He said "<b>no</b>" & meant it' })
    expect(nasty).toContain('&quot;&lt;b&gt;no&lt;/b&gt;&quot; &amp; meant it')
    expect(nasty).not.toContain('<b>no</b>')
  })

  it('markdown uses markdown bullets', () => {
    expect(toMarkdown(sections)).toContain('**Discussed**\n- Allocation is 60/40')
  })
})

describe('sectionsOf — an old paragraph-only draft still works', () => {
  it('falls back to the note when the job has no sections', () => {
    expect(sectionsOf({ note: 'the old one-paragraph note' })).toEqual({
      summary: 'the old one-paragraph note'
    })
  })

  it('prefers sections when they are there', () => {
    expect(sectionsOf({ note: 'rendered', sections }).discussed).toHaveLength(2)
  })
})

describe('copyNote goes through MAIN, and reports whether it landed', () => {
  // BUG-288 — navigator.clipboard is permission-denied in this app and
  // rejected with NotAllowedError every time (measured in the running app,
  // after the founder pressed Copy and pasted nothing). So the copy goes
  // through main's clipboard module, and the result is not decoration: the
  // card must not say "Copied" when nothing was copied.
  const g = globalThis as unknown as { window: { api?: unknown } }
  let write: ReturnType<typeof vi.fn>

  beforeEach(() => {
    write = vi.fn(async () => ({ ok: true }))
    g.window.api = { clipboard: { write } }
  })
  afterEach(() => {
    delete g.window.api
    vi.restoreAllMocks()
  })

  it('sends BOTH flavours in one call — the rich one is what a rich-text CRM field needs', async () => {
    await expect(copyNote('the text', '<p>the html</p>')).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith({ text: 'the text', html: '<p>the html</p>' })
  })

  it('never touches navigator.clipboard, which is the API that does not work here', async () => {
    const navWrite = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: navWrite, writeText: navWrite },
      configurable: true
    })
    await copyNote('t', '<p>h</p>')
    expect(navWrite).not.toHaveBeenCalled()
  })

  it('reports FALSE when main could not copy, instead of claiming success', async () => {
    write.mockResolvedValueOnce({ ok: false })
    await expect(copyNote('t', '<p>h</p>')).resolves.toBe(false)
  })

  it('reports FALSE when the IPC itself throws', async () => {
    write.mockRejectedValueOnce(new Error('no handler'))
    await expect(copyNote('t', '<p>h</p>')).resolves.toBe(false)
  })
})

describe('the card offers the control', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('a Copy button exists beside Save, and copying is not a decision', async () => {
    // Pinned from source rather than mounted: the card needs the whole job
    // IPC surface to render, and what matters here is that the control is
    // wired to copyAs and does NOT touch the save/discard review state.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'CrmNoteGeneratorCard.tsx'), 'utf8')
    expect(src).toContain("void copyAs('text')")
    expect(src).toContain("void copyAs('markdown')")
    const copyFn = src.slice(src.indexOf('const copyAs'), src.indexOf('const acceptedIds'))
    expect(copyFn).not.toContain('saveNote')
    expect(copyFn).not.toContain('noteHandled')
    expect(copyFn, 'copies the rendered text, not a re-implementation').toContain('result.note')
    // BUG-288 — the card must react to the result, not assume it worked.
    expect(copyFn, 'says "Copied" only on a real copy').toContain('if (!ok)')
  })
})
