// @vitest-environment happy-dom
//
// BUG-265 — the connection card said "Connected to Outlook Calendar · Two-way
// sync on · Updated just now" and never said WHICH mailbox. Rendered for real
// (the recipe in scripts/verification/README.md): mock window.api, mount
// through react-dom, read the actual text a user would see.
import { vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as unknown as { window: { api?: unknown } }).window.api = {
    outlook: {
      getStatus: async () => ({
        connected: true,
        configured: true,
        mode: 'readonly',
        account: 'rep@contoso.com'
      }),
      listCalendars: async () => ({ ok: true, calendars: [] })
    }
  }
})
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OutlookConnect } from '../OutlookConnect'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('OutlookConnect (BUG-265)', () => {
  it('shows the connected mailbox address, not just "Connected"', async () => {
    await act(async () => {
      root.render(createElement(OutlookConnect))
      // let the mounted effect's getStatus()/listCalendars() promises settle
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('rep@contoso.com')
  })
})
