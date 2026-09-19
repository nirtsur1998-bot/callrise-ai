// @vitest-environment happy-dom
//
// BUG-282 — seen once on the records sandbox after a call ended: the glance
// line drew its label, the mono evidence and the Useful button with NO
// sentence between them. The gate said "evidence or nothing renders"; a cue
// whose TEXT is blank slipped through it. Same rule, both halves: evidence
// AND a sentence, or the slot stays empty — and a cue that is not drawn is
// never recorded as 'shown'.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GlanceLine, isRenderableCue } from '../GlanceLine'
import { loadAbsorption } from '../hudCore'

let roots: Root[] = []
function mount(el: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(el))
  return container
}
beforeEach(() => {
  roots = []
  localStorage.clear()
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  document.body.innerHTML = ''
})

const EVIDENCE = { kind: 'heard' as const, quote: 'She was my hero. She died a few years ago.' }
const base = { id: 41, kind: 'suggestion', evidence: EVIDENCE, source: 'heard' as const }

describe('BUG-282 — a cue with evidence but no sentence does not render', () => {
  it('blank text: no cue element, the slot stays mounted and empty', () => {
    const c = mount(createElement(GlanceLine, { cue: { ...base, text: '' }, onDismiss: () => {} }))
    expect(c.querySelector('[data-testid="glance-slot"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="glance-line"]')).toBeNull()
    expect(c.querySelector('[data-testid="glance-evidence"]')).toBeNull()
  })

  it('whitespace-only text is blank too', () => {
    const c = mount(
      createElement(GlanceLine, { cue: { ...base, text: '  \n ' }, onDismiss: () => {} })
    )
    expect(c.querySelector('[data-testid="glance-line"]')).toBeNull()
  })

  it('the same cue with a sentence renders — the guard is about the text, not the evidence', () => {
    const c = mount(
      createElement(GlanceLine, {
        cue: { ...base, text: 'Acknowledge the loss before moving on' },
        onDismiss: () => {}
      })
    )
    expect(c.querySelector('[data-testid="glance-line"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="glance-evidence"]')?.textContent).toContain(
      'She was my hero'
    )
  })

  it('a cue that is not drawn is not counted as shown — and a drawn one is (the control)', () => {
    mount(createElement(GlanceLine, { cue: { ...base, text: '' }, onDismiss: () => {} }))
    expect(loadAbsorption().filter((e) => e.type === 'shown')).toEqual([])

    mount(
      createElement(GlanceLine, {
        cue: { ...base, id: 42, text: 'Ask what changed' },
        onDismiss: () => {}
      })
    )
    expect(
      loadAbsorption()
        .filter((e) => e.type === 'shown')
        .map((e) => e.cueId)
    ).toEqual([42])
  })

  it('isRenderableCue is the one gate, and it says so for each half', () => {
    expect(isRenderableCue(null)).toBe(false)
    expect(isRenderableCue({ ...base, text: '' })).toBe(false)
    expect(isRenderableCue({ ...base, text: 'x', evidence: { kind: 'heard', quote: '' } })).toBe(
      false
    )
    expect(isRenderableCue({ ...base, text: 'Ask what changed' })).toBe(true)
  })
})
