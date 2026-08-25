// @vitest-environment happy-dom
//
// BUG-047 follow-up: CountrySelect (used inside the Add/Edit contact
// dialog via ContactEditor.tsx) had the exact same bubble-phase outside-
// click bug as ContactPicker.tsx — see that component's own test file for
// the full explanation of why a stopPropagation()-ing Modal ancestor
// breaks a bubble-phase "click outside to close" listener.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CountrySelect } from '../CountrySelect'

function ModalLikePanel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return createElement(
    'div',
    { onMouseDown: (e: React.MouseEvent) => e.stopPropagation() },
    children
  )
}

function mousedown(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('CountrySelect — BUG-047 (outside-click inside a stopPropagation()-ing dialog)', () => {
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

  it('closes when clicking a different field inside the same modal', () => {
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(ModalLikePanel, null, [
          createElement(CountrySelect, { key: 'select', value: undefined, onChange: () => {} }),
          createElement('input', { key: 'other-field', 'data-testid': 'name-field' })
        ])
      )
    })

    const toggle = container.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    expect(container.querySelector('input[placeholder="Search countries…"]')).not.toBeNull()

    const otherField = container.querySelector('[data-testid="name-field"]') as HTMLElement
    act(() => mousedown(otherField))

    expect(container.querySelector('input[placeholder="Search countries…"]')).toBeNull()
  })

  it('selecting a country still closes it', () => {
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(ModalLikePanel, null, [
          createElement(CountrySelect, { key: 'select', value: undefined, onChange: () => {} })
        ])
      )
    })

    const toggle = container.querySelector('button') as HTMLButtonElement
    act(() => toggle.click())
    const buttons = Array.from(container.querySelectorAll('button'))
    const albania = buttons.find((b) => b.textContent?.includes('Albania')) as HTMLButtonElement
    act(() => albania.click())
    expect(container.querySelector('input[placeholder="Search countries…"]')).toBeNull()
  })
})
