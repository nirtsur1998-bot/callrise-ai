// @vitest-environment happy-dom
//
// End-to-end coverage using the REAL Modal.tsx (portal + focus trap) and
// REAL React.StrictMode (main.tsx wraps the whole app in it) — not the
// simplified stand-in from ContactPicker.outside-click.test.ts, which
// proves the fix at the unit level but not through the exact same
// component stack a real dialog uses.
import { act, createElement, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Modal } from '@renderer/components/Modal'
import { ContactPicker } from '../ContactPicker'
import type { Contact } from '../types'

const CONTACTS: Contact[] = [
  {
    id: 'c1',
    name: 'Kamal',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
]

function renderInRealModal(extraChildren: ReactNode[] = []): void {
  root = createRoot(container)
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        // ModalProps requires `children` explicitly, which createElement's
        // variadic-children overload doesn't resolve against — has to be a
        // prop here.
        // eslint-disable-next-line react/no-children-prop
        createElement(Modal, {
          onClose: () => {},
          initialFocus: false,
          children: [
            createElement(ContactPicker, {
              key: 'picker',
              value: undefined,
              contacts: CONTACTS,
              onSelect: () => {},
              onCreate: async () => null
            }),
            ...extraChildren
          ]
        })
      )
    )
  })
}

let container: HTMLDivElement
let root: Root

function mousedown(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('ContactPicker inside the real Modal + StrictMode (matches main.tsx exactly)', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    document.querySelectorAll('[role="dialog"]').forEach((el) => el.parentElement?.remove())
  })

  it('selecting a contact closes the dropdown', () => {
    renderInRealModal()

    const toggle = document.body.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    expect(document.body.querySelector('input[placeholder="Search contacts…"]')).not.toBeNull()

    const buttons = Array.from(document.body.querySelectorAll('button'))
    const kamalButton = buttons.find((b) => b.textContent?.includes('Kamal')) as HTMLButtonElement
    expect(kamalButton).toBeDefined()
    act(() => kamalButton.click())

    expect(document.body.querySelector('input[placeholder="Search contacts…"]')).toBeNull()
  })

  it('clicking a different field in the same dialog closes the dropdown (the exact reported scenario)', () => {
    renderInRealModal([createElement('input', { key: 'other-field', 'data-testid': 'deal-name' })])

    const toggle = document.body.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    expect(document.body.querySelector('input[placeholder="Search contacts…"]')).not.toBeNull()

    const otherField = document.body.querySelector('[data-testid="deal-name"]') as HTMLElement
    act(() => mousedown(otherField))

    expect(document.body.querySelector('input[placeholder="Search contacts…"]')).toBeNull()
  })
})
