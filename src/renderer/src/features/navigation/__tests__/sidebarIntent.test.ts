// @vitest-environment happy-dom
//
// BUG-286 — clicking the sidebar item for the screen you are already on did
// nothing at all. `navigateTo` ends in setActive(same value), React bails,
// nothing unmounts, and the hub's open detail survives. Driven on the running
// app before the fix: open a call, click sidebar "Calls", and the whole
// page-text hash was IDENTICAL (314106bb5885 -> 314106bb5885), while Home,
// Pipeline and Coaching all navigated away correctly.
//
// The rule is pure, so it is tested directly. The threading of the token
// through the screens is pinned from source at the bottom — those pins are
// what fail on `main`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sidebarIntent, sidebarTarget } from '../sidebarIntent'
import { useStepOutToken } from '@renderer/app/useStepOutToken'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('sidebarIntent — what a sidebar click means', () => {
  it('a DIFFERENT screen navigates, exactly as before', () => {
    expect(sidebarIntent('home', 'calls', true)).toEqual({ kind: 'navigate', id: 'home' })
    expect(sidebarIntent('pipeline', 'calls', true)).toEqual({ kind: 'navigate', id: 'pipeline' })
  })

  it('the screen you are ALREADY on steps out instead of re-navigating', () => {
    expect(sidebarIntent('calls', 'calls', true)).toEqual({ kind: 'step-out' })
  })

  it('the 7-item IA: "Calls" is the same screen as an absorbed past-calls', () => {
    // This is the case the bug was actually reported on — a call detail lives
    // inside the `calls` hub, so the sidebar's Calls IS where you already are.
    expect(sidebarTarget('past-calls', true)).toBe('calls')
    expect(sidebarIntent('past-calls', 'calls', true)).toEqual({ kind: 'step-out' })
  })

  it('the classic IA: the SAME two ids are different screens, and must navigate', () => {
    // The trap: comparing raw ids gets one IA right and the other wrong.
    expect(sidebarTarget('past-calls', false)).toBe('past-calls')
    expect(sidebarIntent('past-calls', 'calls', false)).toEqual({
      kind: 'navigate',
      id: 'past-calls'
    })
  })

  it('CRM absorbed into Pipeline behaves the same way — it is not a Calls rule', () => {
    expect(sidebarTarget('crm', true)).toBe('pipeline')
    expect(sidebarIntent('pipeline', 'pipeline', true)).toEqual({ kind: 'step-out' })
    expect(sidebarIntent('crm', 'pipeline', false)).toEqual({ kind: 'navigate', id: 'crm' })
  })
})

describe('useStepOutToken — the first value is not an event', () => {
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

  /** A screen that opens on a record and drops it when asked to step out. */
  function Screen({ token, onStepOut }: { token: number; onStepOut: () => void }): React.JSX.Element {
    const [open, setOpen] = useState(true)
    useStepOutToken(token, () => {
      setOpen(false)
      onStepOut()
    })
    return createElement('div', null, open ? 'detail' : 'list')
  }

  it('mounting with a non-zero token does NOT close the record', () => {
    // The failure this prevents: a screen opened straight onto a record (a
    // save opening its call, a palette result) would slam shut on mount,
    // because by then the app-wide token has been bumped several times.
    const onStepOut = vi.fn()
    act(() => root.render(createElement(Screen, { token: 7, onStepOut })))
    expect(container.textContent).toBe('detail')
    expect(onStepOut).not.toHaveBeenCalled()
  })

  it('a bump closes it, and each further bump fires exactly once', () => {
    const onStepOut = vi.fn()
    act(() => root.render(createElement(Screen, { token: 7, onStepOut })))
    act(() => root.render(createElement(Screen, { token: 8, onStepOut })))
    expect(container.textContent).toBe('list')
    expect(onStepOut).toHaveBeenCalledTimes(1)

    act(() => root.render(createElement(Screen, { token: 8, onStepOut })))
    expect(onStepOut, 'a re-render with the SAME token is not a new event').toHaveBeenCalledTimes(1)
    act(() => root.render(createElement(Screen, { token: 9, onStepOut })))
    expect(onStepOut).toHaveBeenCalledTimes(2)
  })
})

describe('the token is actually threaded to every screen that owns a detail', () => {
  // __dirname is features/navigation/__tests__ — three up is renderer/src.
  const read = (...p: string[]): string =>
    readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8')

  it('the sidebar goes through navigateFromSidebar, not navigateTo', () => {
    const main = read('app', 'MainApp.tsx')
    // The whole bug is that the sidebar used the plain navigation.
    expect(main).toContain('onSelect={navigateFromSidebar}')
    expect(main).toContain('sidebarIntent(id, active, navPreviewEnabled)')
  })

  it('every hub and list that can show a detail receives stepOutToken', () => {
    expect(read('app', 'MainApp.tsx'), 'CallsHub').toContain('stepOutToken={stepOutToken}')
    expect(read('app', 'CallsHub.tsx'), 'CallsHub -> PastCallsView').toContain(
      'stepOutToken={stepOutToken}'
    )
    expect(read('app', 'PipelineHub.tsx'), 'PipelineHub -> CrmView').toContain(
      'stepOutToken={stepOutToken}'
    )
    const crm = read('app', 'CrmView.tsx')
    expect((crm.match(/stepOutToken={stepOutToken}/g) ?? []).length, 'contacts AND deals').toBe(2)
  })

  it('each detail-owning view consumes it through the shared hook', () => {
    for (const [label, path] of [
      ['past calls', ['features', 'calls', 'PastCallsView.tsx']],
      ['contacts', ['features', 'contacts', 'ContactsView.tsx']],
      ['deals', ['features', 'deals', 'DealsView.tsx']]
    ] as const) {
      expect(read(...path), label).toContain('useStepOutToken(stepOutToken')
    }
  })
})
