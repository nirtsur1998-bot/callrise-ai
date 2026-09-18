// @vitest-environment happy-dom
//
// BUG-266 / BUG-267 — the week grid opened on the night hours because its
// scroll container never clamped (the chain above it was `display: block`
// at AppShell's padded content box, so every `flex-1` below it was inert and
// the whole 24-hour grid became page content), and a block scrolled mostly
// out of view left a bare colour sliver under the all-day row.
//
// Layout itself cannot be measured here (happy-dom has no box model — the
// numbers are in the tracker entry, measured in the running app). What this
// pins is the CHAIN and the CLASSES that made those numbers true, so a
// refactor that drops one link fails loudly instead of quietly re-opening
// the week at midnight.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import AppShell from '../../../app/AppShell'
import { WeekGrid } from '../WeekGrid'
import type { CalendarItem } from '../types'

const RENDERER = join(__dirname, '..', '..', '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const source = (rel: string): string => strip(readFileSync(join(RENDERER, rel), 'utf8'))

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
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  document.body.innerHTML = ''
})

describe('BUG-266 — the height chain from AppShell down to the week grid', () => {
  it('AppShell: clampContent turns the padded content box into a flex column that still scrolls', () => {
    const c = mount(
      createElement(AppShell, {
        sidebar: createElement('div'),
        copilot: createElement('div'),
        title: 'Calendar',
        clampContent: true,
        children: createElement('div', { 'data-testid': 'child' })
      })
    )
    const box = c.querySelector('[data-testid="child"]')!.parentElement!
    for (const cls of ['flex', 'flex-col', 'min-h-0', 'flex-1', 'overflow-y-auto', 'px-8', 'py-7'])
      expect(box.classList.contains(cls), `content box has ${cls}`).toBe(true)
  })

  it('AppShell: without the flag the content box is the plain block it always was', () => {
    const c = mount(
      createElement(AppShell, {
        sidebar: createElement('div'),
        copilot: createElement('div'),
        title: 'Home',
        children: createElement('div', { 'data-testid': 'child' })
      })
    )
    const box = c.querySelector('[data-testid="child"]')!.parentElement!
    expect(box.classList.contains('flex')).toBe(false)
    expect(box.classList.contains('overflow-y-auto')).toBe(true)
  })

  it('MainApp asks for the clamp on the calendar screen and on the Pipeline hub that hosts it', () => {
    const main = source('app/MainApp.tsx')
    expect(main).toMatch(/clampContent=\{active === 'calendar' \|\| active === 'pipeline'\}/)
    // …and its keyed wrapper is a flex link for the same screens.
    expect(main).toMatch(
      /active === 'assistant' \|\| active === 'calendar' \|\| active === 'pipeline'\s*\?\s*'animate-view flex min-h-0 flex-1 flex-col'/
    )
  })

  it('PipelineHub is a flex link only while its Calendar tab is showing', () => {
    const hub = source('app/PipelineHub.tsx')
    expect(hub).toContain(
      `className={tab === 'calendar' ? 'flex min-h-0 flex-1 flex-col' : undefined}`
    )
  })

  it('CalendarView takes the remaining height as a flex item, not as 100% of a parent it overflows', () => {
    const view = source('features/calendar/CalendarView.tsx')
    expect(view).toContain('<div className="flex min-h-0 flex-1 flex-col">')
    expect(view).not.toContain('<div className="flex h-full flex-col">')
  })
})

describe('BUG-267 — a block scrolled partly out of view keeps its title at the edge', () => {
  const day = new Date(2026, 8, 14, 12, 14)
  const item: CalendarItem = {
    key: 'event-1',
    kind: 'event',
    title: 'Linda — quarterly check-in',
    start: day,
    end: new Date(2026, 8, 14, 13, 30),
    allDay: false
  }

  it('the title row is sticky inside a block that clips with overflow-clip (not overflow-hidden)', () => {
    const c = mount(
      createElement(WeekGrid, {
        cursor: day,
        items: [item],
        onNewEvent: () => {},
        onEditEvent: () => {}
      })
    )
    const block = Array.from(c.querySelectorAll('button[title]')).find((b) =>
      (b.getAttribute('title') ?? '').startsWith('Linda')
    )
    expect(block, 'the event renders as a timed block').toBeDefined()
    // `hidden` would make the block its own scroll container and the sticky
    // title would pin to the block instead of to the grid's visible edge.
    expect(block!.classList.contains('overflow-clip')).toBe(true)
    expect(block!.classList.contains('overflow-hidden')).toBe(false)
    const title = block!.querySelector('[data-testid="week-block-title"]')!
    expect(title.classList.contains('sticky')).toBe(true)
    expect(title.classList.contains('top-0')).toBe(true)
    expect(title.textContent).toContain('Linda — quarterly check-in')
  })
})
