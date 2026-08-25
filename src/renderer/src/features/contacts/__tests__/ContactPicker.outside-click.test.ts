// @vitest-environment happy-dom
//
// BUG-047 regression test: every dialog that hosts ContactPicker (Add/Edit
// deal, CallDetail, EventDialog) renders inside Modal.tsx, whose panel does
// `onMouseDown={(e) => e.stopPropagation()}` so a click inside the dialog
// can't be mistaken for a backdrop click and close the whole modal. That
// stop happens on the BUBBLE phase, downstream (in bubble order) of
// ContactPicker's own document-level "click outside to close" listener —
// so a plain bubble-phase listener never even sees a mousedown that landed
// anywhere else inside the same modal, and the dropdown stayed open no
// matter where else in the dialog you clicked. This test reproduces that
// exact shape (a stopPropagation()-ing ancestor between the picker and
// document) without needing the real Modal/portal machinery.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContactPicker } from '../ContactPicker'
import type { Contact } from '../types'

const CONTACTS: Contact[] = [
  {
    id: 'c1',
    name: 'Kamal',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'c2',
    name: 'Cece',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
]

/** Stands in for Modal.tsx's panel — same stopPropagation() shape, none of
 *  the real portal/focus-trap machinery, which isn't what this bug is about. */
function ModalLikePanel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return createElement(
    'div',
    { onMouseDown: (e: React.MouseEvent) => e.stopPropagation(), 'data-testid': 'modal-panel' },
    children
  )
}

function mousedown(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('ContactPicker — BUG-047 (outside-click inside a stopPropagation()-ing dialog)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  it('closes when clicking a DIFFERENT field inside the same modal, not just clicks outside the modal entirely', () => {
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(ModalLikePanel, null, [
          createElement(ContactPicker, {
            key: 'picker',
            value: undefined,
            contacts: CONTACTS,
            onSelect: () => {},
            onCreate: async () => null
          }),
          createElement('input', { key: 'other-field', 'data-testid': 'deal-name-field' })
        ])
      )
    })

    const toggle = container.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    expect(container.querySelector('input[placeholder="Search contacts…"]')).not.toBeNull()

    // A click on a totally unrelated field INSIDE the same modal — e.g. the
    // Deal Name input in the real dialog — is exactly the case that used to
    // never reach the picker's own outside-click listener.
    const otherField = container.querySelector('[data-testid="deal-name-field"]') as HTMLElement
    act(() => mousedown(otherField))

    expect(container.querySelector('input[placeholder="Search contacts…"]')).toBeNull()
  })

  it('still closes on a click genuinely outside the modal entirely (unchanged behavior)', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(ModalLikePanel, null, [
          createElement(ContactPicker, {
            key: 'picker',
            value: undefined,
            contacts: CONTACTS,
            onSelect: () => {},
            onCreate: async () => null
          })
        ])
      )
    })

    const toggle = container.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    expect(container.querySelector('input[placeholder="Search contacts…"]')).not.toBeNull()

    act(() => mousedown(outside))
    expect(container.querySelector('input[placeholder="Search contacts…"]')).toBeNull()
    outside.remove()
  })

  it('a click INSIDE the picker itself (e.g. the search box) never closes it', () => {
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(ModalLikePanel, null, [
          createElement(ContactPicker, {
            key: 'picker',
            value: undefined,
            contacts: CONTACTS,
            onSelect: () => {},
            onCreate: async () => null
          })
        ])
      )
    })

    const toggle = container.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    const search = container.querySelector('input[placeholder="Search contacts…"]') as HTMLElement
    act(() => mousedown(search))
    expect(container.querySelector('input[placeholder="Search contacts…"]')).not.toBeNull()
  })

  it('selecting a contact from the list still closes it (the already-working path, unaffected)', () => {
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(ModalLikePanel, null, [
          createElement(ContactPicker, {
            key: 'picker',
            value: undefined,
            contacts: CONTACTS,
            onSelect: () => {},
            onCreate: async () => null
          })
        ])
      )
    })

    const toggle = container.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    const buttons = Array.from(container.querySelectorAll('button'))
    const kamalButton = buttons.find((b) => b.textContent?.includes('Kamal')) as HTMLButtonElement
    act(() => kamalButton.click())
    expect(container.querySelector('input[placeholder="Search contacts…"]')).toBeNull()
  })
})
