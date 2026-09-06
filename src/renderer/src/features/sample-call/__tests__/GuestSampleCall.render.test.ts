// @vitest-environment happy-dom
//
// M36 Stage 1 — THE SAMPLE CALL BEFORE THE ACCOUNT (the founder, 2026-09-06:
// "Move the wall"). Three things pinned, rendered for real:
//   1. the auth screen offers "See a sample call first" only when a host
//      wires it, and never on the confirm-code step;
//   2. the guest page shows the whole sample with nothing saved, and every
//      exit — the bar's button and both of the sample's own calls to action —
//      leads to Create an account, one click; Log in stays one click away;
//   3. the gate itself (App.tsx): logged out → auth → sample → "Create an
//      account" → the SIGNUP form, not Log in.
import { vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as unknown as { window: { api?: unknown } }).window.api = {
    platform: 'win32',
    transcription: { openMicSettings: async () => undefined },
    app: { isPackaged: async () => true },
    auth: {
      signIn: async () => ({ ok: false, message: 'no' }),
      signUp: async () => ({ ok: false, message: 'no' }),
      verifyOtp: async () => ({ ok: false, message: 'no' }),
      resendCode: async () => ({ ok: false, message: 'no' })
    }
  }
})
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthScreen } from '@renderer/features/auth/AuthScreen'
import { GuestSampleCall } from '../GuestSampleCall'
import { SAMPLE_SEGMENTS } from '../sampleCall'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []
function mount(el: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(el))
  return container
}
const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const buttonNamed = (c: HTMLElement, text: string): HTMLButtonElement | undefined =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)

beforeEach(() => {
  roots = []
  localStorage.clear()
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  document.body.innerHTML = ''
})

describe('AuthScreen — the door past the wall', () => {
  it('offers "See a sample call first" when wired, and calls it', () => {
    const onSample = vi.fn()
    const c = mount(createElement(AuthScreen, { configured: true, onSample }))
    const link = c.querySelector('[data-testid="auth-see-sample"]')
    expect(link?.textContent).toBe('See a sample call first')
    expect(c.textContent).toContain('No account needed — nothing is saved.')
    click(link)
    expect(onSample).toHaveBeenCalledTimes(1)
  })
  it('shows no such link when no host wires it (every other use of the screen is unchanged)', () => {
    const c = mount(createElement(AuthScreen, { configured: true }))
    expect(c.querySelector('[data-testid="auth-see-sample"]')).toBeNull()
  })
  it('initialMode "signup" lands on the Create-your-account form', () => {
    const c = mount(createElement(AuthScreen, { configured: true, initialMode: 'signup', onSample: () => {} }))
    expect(c.textContent).toContain('Create your account')
    expect(c.querySelector('[data-testid="auth-see-sample"]')).not.toBeNull()
  })
})

describe('GuestSampleCall — the sample outside the signed-in tree', () => {
  it('renders the whole sample, says no account is needed, and every exit is Create an account or Log in', () => {
    const onCreateAccount = vi.fn()
    const onLogin = vi.fn()
    const c = mount(createElement(GuestSampleCall, { onCreateAccount, onLogin }))
    const text = c.textContent ?? ''
    expect(text).toContain('nothing here is saved, and no account is needed to look')
    expect(text).toContain('This is a sample call.')
    for (const seg of SAMPLE_SEGMENTS) expect(text).toContain(seg.text.slice(0, 40))
    // the bar
    click(buttonNamed(c, 'Log in'))
    expect(onLogin).toHaveBeenCalledTimes(1)
    click(buttonNamed(c, 'Create an account'))
    expect(onCreateAccount).toHaveBeenCalledTimes(1)
    // the sample's own two calls to action lead to the account too — a guest
    // cannot start a real call or add a key without one
    const exits = Array.from(c.querySelectorAll('button')).filter((b) =>
      /Add a key|Start my first call/.test(b.textContent ?? '')
    )
    expect(exits).toHaveLength(2)
    for (const b of exits) click(b)
    expect(onCreateAccount).toHaveBeenCalledTimes(3)
    // stores nothing but the sample's own seen flag
    expect(Object.keys(localStorage).filter((k) => k !== 'callrise.sampleCall.seen')).toEqual([])
  })
})
