// @vitest-environment happy-dom
//
// BUG-273 — the post-call "Detected X on this call — no contact linked yet"
// banner never looked contacts up by name: `existingContactName` was set only
// when the identity had been resolved FROM a contact record, so a buyer who
// introduced themselves got "Create contact for X" even when one — or two —
// contacts already carried that name. On the founder's profile two live
// contacts are called "Harvey"; the banner offered a third.
//
// The banner now takes the same `suggestion` shape the live chip and the
// disagreement notice already use (link / ambiguous / create), and renders the
// ambiguous case as the candidate list it is — with a distinguisher, because
// two rows both reading "Harvey" are the failure, not the fix.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdentityContactSuggestion } from '../IdentityContactSuggestion'

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

const buttons = (): string[] =>
  Array.from(container.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())

const HARVEYS = [
  { id: 'h1', name: 'Harvey' },
  { id: 'h2', name: 'Harvey' }
]

describe('IdentityContactSuggestion — an ambiguous name is a list, never a "Create" (BUG-273)', () => {
  it('two contacts with the spoken name → one link button per candidate, each distinguished, and NO create button', () => {
    const linked: string[] = []
    act(() => {
      root.render(
        createElement(IdentityContactSuggestion, {
          name: 'Harvey Welsh',
          suggestion: { kind: 'ambiguous', candidates: HARVEYS },
          describe: (c) => (c.id === 'h1' ? '5 calls · last 3d ago' : 'no calls yet'),
          onLink: () => {},
          onLinkCandidate: (id) => linked.push(id),
          onCreate: () => {},
          onDismiss: () => {}
        })
      )
    })
    const text = container.textContent ?? ''
    expect(text).toContain('2 of your contacts are called that')
    expect(buttons().some((b) => b.startsWith('Create contact'))).toBe(false)
    const links = buttons().filter((b) => b.startsWith('Link to Harvey'))
    expect(links).toHaveLength(2)
    expect(text).toContain('5 calls · last 3d ago')
    expect(text).toContain('no calls yet')

    const second = Array.from(container.querySelectorAll('button')).filter((b) =>
      (b.textContent ?? '').includes('no calls yet')
    )[0]
    act(() => second.click())
    expect(linked).toEqual(['h2'])
  })

  it('exactly one contact with the spoken name → "Link to" that contact, no create', () => {
    act(() => {
      root.render(
        createElement(IdentityContactSuggestion, {
          name: 'Harvey Welsh',
          suggestion: { kind: 'link', contact: { id: 'h1', name: 'Harvey' } },
          onLink: () => {},
          onLinkCandidate: () => {},
          onCreate: () => {},
          onDismiss: () => {}
        })
      )
    })
    expect(buttons()).toContain('Link to Harvey')
    expect(buttons().some((b) => b.startsWith('Create contact'))).toBe(false)
  })

  it('no contact with the spoken name → the original "Create contact for X" (unchanged)', () => {
    act(() => {
      root.render(
        createElement(IdentityContactSuggestion, {
          name: 'Harvey Welsh',
          suggestion: { kind: 'create' },
          onLink: () => {},
          onLinkCandidate: () => {},
          onCreate: () => {},
          onDismiss: () => {}
        })
      )
    })
    expect(buttons()).toContain('Create contact for Harvey Welsh')
  })

  it('a record-resolved identity (existingContactName) still takes priority over the name lookup', () => {
    act(() => {
      root.render(
        createElement(IdentityContactSuggestion, {
          name: 'Harvey Welsh',
          existingContactName: 'Harvey Welsh (record)',
          suggestion: { kind: 'ambiguous', candidates: HARVEYS },
          onLink: () => {},
          onLinkCandidate: () => {},
          onCreate: () => {},
          onDismiss: () => {}
        })
      )
    })
    expect(buttons()).toContain('Link to Harvey Welsh (record)')
    expect(buttons().filter((b) => b.startsWith('Link to'))).toHaveLength(1)
  })
})
