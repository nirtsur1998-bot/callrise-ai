// @vitest-environment happy-dom
//
// M34 3c / 3d / 3e — the small live-screen pieces, rendered for real through
// react-dom (the same harness useCueSettings.test.ts uses). LiveView itself
// cannot be render-tested (BUG-140); these pieces can, so they are.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuietToggle } from '../components/QuietToggle'
import { DealFactsLine } from '../components/DealFactsLine'
import { SuggestionRail } from '../components/SuggestionRail'
import { PostCallReasonBanner } from '../components/PostCallReasonBanner'
import { resetOutcomeReasonPrefs, skipStreak } from '@renderer/features/deals/outcomeReasonPref'
import type { LiveCue } from '../useLiveCues'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const render = (el: React.ReactElement): void => {
  act(() => {
    root.render(el)
  })
}
const click = (el: Element | null): void => {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetOutcomeReasonPrefs()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('QuietToggle (3c-A)', () => {
  it('reports its state through aria-pressed and asks for the opposite on click', () => {
    const onToggle = vi.fn()
    render(createElement(QuietToggle, { quiet: false, onToggle }))
    const btn = container.querySelector('button')!
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    click(btn)
    expect(onToggle).toHaveBeenCalledWith(true)
    render(createElement(QuietToggle, { quiet: true, onToggle }))
    expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('DealFactsLine (3d)', () => {
  it('renders the three parts in order, and nothing at all for null facts', () => {
    render(
      createElement(DealFactsLine, {
        facts: { stage: 'Proposal', risk: 'high', lastCall: { at: '2026-08-27T09:00:00.000Z', nextAction: 'Send the pricing comparison' } }
      })
    )
    const line = container.querySelector('[data-testid="live-deal-facts"]')!
    expect(line.textContent).toMatch(/^Proposal·high risk·last call (\d+ Aug|Aug \d+): “Send the pricing comparison”$/)
    render(createElement(DealFactsLine, { facts: null }))
    expect(container.querySelector('[data-testid="live-deal-facts"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})

describe('SuggestionRail collapsed (3c-A)', () => {
  const cues: LiveCue[] = [
    { id: 1, kind: 'discovery', text: 'Ask about timeline' } as LiveCue,
    { id: 2, kind: 'objection', text: 'Price came up' } as LiveCue
  ]
  it('in Quiet it is a count the rep can open; leaving and re-entering Quiet collapses it again', () => {
    const onDismiss = vi.fn()
    render(createElement(SuggestionRail, { suggestions: cues, onDismiss, collapsed: true }))
    const pill = container.querySelector('button')!
    expect(pill.textContent).toBe('2 suggestions')
    expect(container.querySelector('[role="log"]')).toBeNull()
    click(pill) // peek
    expect(container.querySelector('[role="log"]')).not.toBeNull()
    render(createElement(SuggestionRail, { suggestions: cues, onDismiss, collapsed: false })) // Quiet off
    expect(container.querySelector('[role="log"]')).not.toBeNull()
    render(createElement(SuggestionRail, { suggestions: cues, onDismiss, collapsed: true })) // Quiet on again
    expect(container.querySelector('button')!.textContent, 'the peek leaked into the next quiet stretch').toBe('2 suggestions')
  })
  it('nothing is dropped: the count tracks the suggestions behind the pill', () => {
    render(createElement(SuggestionRail, { suggestions: cues.slice(0, 1), onDismiss: vi.fn(), collapsed: true }))
    expect(container.querySelector('button')!.textContent).toBe('1 suggestion')
    render(createElement(SuggestionRail, { suggestions: [], onDismiss: vi.fn(), collapsed: true }))
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('PostCallReasonBanner (3e)', () => {
  const prompt = { kind: 'prompt' as const, dealId: 'd1', dealTitle: 'Acme', end: 'lost' as const, stageLabel: 'Lost' }

  it('none and null render nothing', () => {
    render(createElement(PostCallReasonBanner, { decision: null, onDone: vi.fn() }))
    expect(container.innerHTML).toBe('')
    render(createElement(PostCallReasonBanner, { decision: { kind: 'none' }, onDone: vi.fn() }))
    expect(container.innerHTML).toBe('')
  })

  it('skipping is ONE action, counts on the shared streak, and tells the parent it is done', () => {
    const onDone = vi.fn()
    render(createElement(PostCallReasonBanner, { decision: prompt, onDone, saveReason: vi.fn(async () => ({})) }))
    expect(container.querySelector('[data-testid="post-call-reason"]')).not.toBeNull()
    click(container.querySelector('button[aria-label^="Skip"]'))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(skipStreak()).toBe(1)
  })

  it('saving writes the reason to the deal, resets the streak, and is done', () => {
    const saveReason = vi.fn(async () => ({}))
    const onDone = vi.fn()
    render(createElement(PostCallReasonBanner, { decision: prompt, onDone, saveReason }))
    // The M32 prompt is a single-line <input> with a Save button (no form) —
    // type through the native setter so React's onChange sees the value.
    const input = container.querySelector('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'price, and budget elsewhere')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save') ?? null)
    expect(saveReason).toHaveBeenCalledWith('d1', 'price, and budget elsewhere')
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(skipStreak()).toBe(0)
  })

  it('the retired notice renders once and its dismiss is done', () => {
    const onDone = vi.fn()
    render(createElement(PostCallReasonBanner, { decision: { kind: 'retired-notice' }, onDone }))
    expect(container.textContent).toMatch(/stop asking/i)
    click(container.querySelector('button'))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
