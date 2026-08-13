// @vitest-environment happy-dom
//
// M26 Phase 4.6 — the persistent "a call is still running" indicator, visible
// outside the Live Calls screen (App.tsx renders it as a sibling of MainApp,
// same reason as ActivityCenter/InterruptedCallPrompt). Drives the REAL
// component, only useLiveCall() and the nav signal are mocked.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveStatus } from '../types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mockStatus: LiveStatus = 'idle'
vi.mock('../useLiveCall', () => ({
  useLiveCall: () => ({ status: mockStatus })
}))

const goToLiveCalls = vi.fn()
vi.mock('../liveCallNav', () => ({
  goToLiveCalls: () => goToLiveCalls()
}))

const { LiveCallPill } = await import('../LiveCallPill')

describe('LiveCallPill', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    goToLiveCalls.mockClear()
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  function render(status: LiveStatus): void {
    mockStatus = status
    root = createRoot(container)
    act(() => {
      root.render(createElement(LiveCallPill))
    })
  }

  const inactiveStatuses: LiveStatus[] = [
    'attaching',
    'idle',
    'requesting',
    'connecting',
    'denied',
    'no-device',
    'no-key',
    'error'
  ]

  for (const status of inactiveStatuses) {
    it(`renders nothing for status '${status}'`, () => {
      render(status)
      expect(container.querySelector('button')).toBeNull()
    })
  }

  it("renders the pill for 'listening', with a click that calls goToLiveCalls", () => {
    render('listening')
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('Live call')
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(goToLiveCalls).toHaveBeenCalledTimes(1)
  })

  it("renders a distinct label for 'reconnecting'", () => {
    render('reconnecting')
    const button = container.querySelector('button')
    expect(button?.textContent).toContain('Reconnecting')
  })

  it("renders a distinct label for 'paused'", () => {
    render('paused')
    const button = container.querySelector('button')
    expect(button?.textContent).toContain('Call paused')
  })
})
