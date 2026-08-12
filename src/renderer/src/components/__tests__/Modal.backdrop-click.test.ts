// @vitest-environment happy-dom
//
// BUG-047 root cause: Modal used to close-the-whole-dialog-on-backdrop-click
// by stopping mousedown from bubbling past the panel (`onMouseDown={(e) =>
// e.stopPropagation()}`). That's a broad instrument — it silently absorbed
// EVERY mousedown anywhere inside the dialog, including ones aimed at a
// completely unrelated field, which is exactly what broke ContactPicker's
// and CountrySelect's own "click elsewhere to close" listeners (they never
// even saw the event). Fixed by checking `e.target === e.currentTarget` on
// the backdrop itself instead — a click on any descendant (the panel, or
// anything in it) can never match that, so nothing needs to be stopped, and
// the event bubbles all the way to document normally.
//
// Every createElement(Modal, { children: ... }) below passes children as a
// prop rather than a trailing arg — ModalProps requires `children`
// explicitly, which createElement's variadic-children overload doesn't
// resolve against, so the props-object form is the only one TypeScript
// accepts here (hence the react/no-children-prop disable on each one).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../Modal'

function mousedown(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('Modal — backdrop click vs. content click', () => {
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

  it('closes on a genuine backdrop click', () => {
    const onClose = vi.fn()
    root = createRoot(container)
    act(() => {
      root.render(
        // eslint-disable-next-line react/no-children-prop -- see file header
        createElement(Modal, {
          onClose,
          initialFocus: false,
          children: createElement('button', { key: 'inner' }, 'Inner content')
        })
      )
    })

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement
    const scrim = dialog.parentElement?.querySelector('.animate-scrim') as HTMLElement
    expect(scrim).toBeDefined()
    act(() => mousedown(scrim))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close on a click inside the panel', () => {
    const onClose = vi.fn()
    root = createRoot(container)
    act(() => {
      root.render(
        // eslint-disable-next-line react/no-children-prop -- see file header
        createElement(Modal, {
          onClose,
          initialFocus: false,
          children: createElement('button', { key: 'inner' }, 'Inner content')
        })
      )
    })

    const inner = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Inner content'
    ) as HTMLElement
    act(() => mousedown(inner))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not swallow a mousedown aimed elsewhere in the panel — a sibling field still sees it (this is the actual BUG-047 mechanism)', () => {
    const onClose = vi.fn()
    const outsideClickSpy = vi.fn()
    root = createRoot(container)
    act(() => {
      root.render(
        // eslint-disable-next-line react/no-children-prop -- see file header
        createElement(Modal, {
          onClose,
          initialFocus: false,
          children: [
            createElement('div', { key: 'picker-stand-in', 'data-testid': 'picker' }),
            createElement('input', { key: 'other-field', 'data-testid': 'other-field' })
          ]
        })
      )
    })

    // A document-level listener, exactly like ContactPicker's/CountrySelect's
    // own "click outside to close" mechanism, watching for ANY mousedown.
    document.addEventListener('mousedown', outsideClickSpy)
    const otherField = document.body.querySelector('[data-testid="other-field"]') as HTMLElement
    act(() => mousedown(otherField))
    document.removeEventListener('mousedown', outsideClickSpy)

    expect(outsideClickSpy).toHaveBeenCalledTimes(1) // reached document — the old code never let this happen
    expect(onClose).not.toHaveBeenCalled() // and the whole dialog correctly stayed open
  })
})
