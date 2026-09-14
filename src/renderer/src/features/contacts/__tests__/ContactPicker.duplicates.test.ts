// @vitest-environment happy-dom
//
// BUG-273, the picker half. The "Link a contact" dropdown showed two rows that
// read identically — "Harvey" and "Harvey" — for the founder's two same-named
// contacts, with nothing to tell the one with five calls from the empty
// duplicate. The first row happened to be right, by luck.
//
// The picker now accepts an optional `describe(contact)` and renders it ONLY
// under rows whose name collides with another row in the same result list —
// so the common case (unique names) is pixel-identical to before, and the
// collision case shows the one thing that separates them.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContactPicker } from '../ContactPicker'
import type { Contact } from '../types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const stamp = { createdAt: '2026-09-09T03:34:44.000Z', updatedAt: '2026-09-09T03:34:44.000Z' }
const TWO_HARVEYS: Contact[] = [
  { id: 'h1', name: 'Harvey', ...stamp },
  { id: 'h2', name: 'Harvey', ...stamp },
  { id: 'l1', name: 'Linda', ...stamp }
]

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

function openPicker(contacts: Contact[], describe?: (c: Contact) => string | undefined): void {
  act(() => {
    root.render(
      createElement(ContactPicker, {
        value: undefined,
        contacts,
        onSelect: () => {},
        onCreate: async () => null,
        describe
      })
    )
  })
  const trigger = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('Link a contact')
  )
  expect(trigger, 'the picker trigger must render').toBeDefined()
  act(() => trigger!.click())
}

const describeById = (c: Contact): string | undefined =>
  c.id === 'h1' ? '5 calls · last 3d ago' : c.id === 'h2' ? 'no calls yet' : 'Linda has calls too'

describe('ContactPicker — colliding names get a distinguisher (BUG-273)', () => {
  it('both same-named rows show their descriptor; the unique row does not', () => {
    openPicker(TWO_HARVEYS, describeById)
    const text = container.textContent ?? ''
    expect(text).toContain('5 calls · last 3d ago')
    expect(text).toContain('no calls yet')
    // Linda's name is unique in the list, so her descriptor is NOT shown —
    // the distinguisher exists for collisions, not as a new column.
    expect(text).not.toContain('Linda has calls too')
  })

  it('without a describe prop the collision renders as before (no crash, both rows present)', () => {
    openPicker(TWO_HARVEYS)
    // A row's text is its avatar letter plus the name ("HHarvey"); the trigger
    // and the "Add new contact" button contain neither.
    const rows = Array.from(container.querySelectorAll('button')).filter(
      (b) => (b.textContent ?? '').replace(/\s+/g, '') === 'HHarvey'
    )
    expect(rows).toHaveLength(2)
  })
})
