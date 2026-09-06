// @vitest-environment happy-dom
//
// M36 Stage 2 — the glance HUD's two components, mounted for real. The
// constraint that does not move: never claim what it does not know — a cue
// without evidence does not render; unsure stays unsure.
import { vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as unknown as { window: { api?: unknown } }).window.api = { platform: 'win32' }
})
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GlanceLine } from '../GlanceLine'
import { StateStrip } from '../StateStrip'
import { loadAbsorption, summarizeAbsorption } from '../hudCore'

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

describe('GlanceLine', () => {
  it('does not render a cue without evidence — no claim without a source', () => {
    const c = mount(
      createElement(GlanceLine, {
        cue: { id: 1, kind: 'objection', text: 'Anchor on the monthly bill', evidence: { kind: 'heard', quote: '   ' }, source: 'heard' },
        onDismiss: () => {}
      })
    )
    expect(c.querySelector('[data-testid="glance-line"]')).toBeNull()
    expect(summarizeAbsorption(loadAbsorption()).shown).toBe(0)
  })
  it('renders a heard cue with its excerpt, records shown once, and space marks it useful once', () => {
    const cue = { id: 2, kind: 'objection', text: 'Anchor on the monthly bill', evidence: { kind: 'heard' as const, quote: "that's more than we budgeted" }, source: 'heard' as const }
    const c = mount(createElement(GlanceLine, { cue, onDismiss: () => {} }))
    expect(c.querySelector('[data-testid="glance-line"]')?.textContent).toContain('Anchor on the monthly bill')
    expect(c.querySelector('[data-testid="glance-evidence"]')?.textContent).toBe('heard: "that\'s more than we budgeted"')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    })
    const s = summarizeAbsorption(loadAbsorption())
    expect(s.shown).toBe(1)
    expect(s.useful).toBe(1)
    expect(s.byKind.objection.usefulRate).toBe(1)
  })
  it('a model suggestion says "suggestion", never "now"', () => {
    const c = mount(
      createElement(GlanceLine, {
        cue: { id: 3, kind: 'discovery', text: 'Ask who else decides', evidence: { kind: 'heard', quote: 'my husband would need to see it' }, source: 'suggestion' },
        onDismiss: () => {}
      })
    )
    const text = c.querySelector('[data-testid="glance-line"]')?.textContent ?? ''
    expect(text).toContain('suggestion')
    expect(text.startsWith('now')).toBe(false)
  })
  it('a measured cue shows the measurement, and dismiss is recorded', () => {
    const onDismiss = vi.fn()
    const c = mount(
      createElement(GlanceLine, {
        cue: { id: 4, kind: 'pace', text: 'Slow down a touch', evidence: { kind: 'measured', label: 'you: 205 words/min over the last 15 s (limit 185)' }, source: 'heard' },
        onDismiss
      })
    )
    expect(c.querySelector('[data-testid="glance-evidence"]')?.textContent).toContain('205 words/min')
    act(() => (c.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click())
    expect(onDismiss).toHaveBeenCalledWith(4)
    expect(summarizeAbsorption(loadAbsorption()).dismissed).toBe(1)
  })
})

describe('StateStrip', () => {
  const segs = [
    { speaker: 0, role: 'rep' as const, text: 'one two three four' },
    { speaker: 1, role: 'other' as const, text: 'five' },
    { speaker: 2, text: 'six seven' }
  ]
  it('keeps UNSURE visible, measures talk share in words and excludes unsure words, folds the deal facts in', () => {
    const now = 10_000
    const c = mount(
      createElement(StateStrip, {
        status: 'listening',
        health: null,
        segments: segs,
        latestAt: now - 500,
        now,
        dealFacts: { stage: 'Proposal', risk: 'high', lastCallAt: null } as never
      })
    )
    expect(c.querySelector('[data-testid="strip-speaking"]')?.textContent).toContain('unsure who')
    const share = c.querySelector('[data-testid="strip-talkshare"]')
    expect(share?.textContent).toContain('80%')
    expect(share?.getAttribute('title')).toContain('2 unsure (not counted)')
    expect(c.querySelector('[data-testid="strip-deal"]')?.textContent).toContain('Proposal')
  })
  it('shows a capture problem as a state', () => {
    const c = mount(
      createElement(StateStrip, {
        status: 'listening',
        health: { liveness: 'capture-dead' } as never,
        segments: [],
        latestAt: null,
        now: 0,
        dealFacts: null
      })
    )
    expect(c.querySelector('[data-testid="strip-health"]')?.textContent).toBe('No audio')
    expect(c.querySelector('[data-testid="strip-speaking"]')?.textContent).toContain('quiet')
  })
})
