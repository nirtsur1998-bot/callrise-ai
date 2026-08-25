// @vitest-environment happy-dom
//
// M29 — the one-time auto-update notice. Shown only while
// autoUpdateNoticePending is true in REAL settings; dismissing persists
// { autoUpdateNoticePending: false } (an install-wide dismissal, not a
// per-window one) and does NOT touch autoUpdateEnabled — closing the card
// is not opting out.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoUpdateNoticeCard } from '../AutoUpdateNoticeCard'

let root: Root | null = null
let container: HTMLDivElement
let pending: boolean
const update = vi.fn(async (patch: Record<string, unknown>) => {
  if ('autoUpdateNoticePending' in patch) pending = patch.autoUpdateNoticePending === true
  return {}
})

function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      get: () => Promise.resolve({ autoUpdateNoticePending: pending }),
      update
    }
  }
}

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AutoUpdateNoticeCard, { onNavigate: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  update.mockClear()
  pending = true
  stubApi()
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

describe('AutoUpdateNoticeCard', () => {
  it('renders the honest copy while the notice is pending', async () => {
    await mount()
    expect(container.textContent).toContain('CallRise now keeps itself up to date')
    expect(container.textContent).toContain('install when you quit')
    expect(container.textContent).toContain('Turn it off in Settings')
    expect(update).not.toHaveBeenCalled()
  })

  it('dismiss hides the card and persists ONLY the notice flag — never the enabled pref', async () => {
    await mount()
    const dismiss = container.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement
    expect(dismiss).toBeTruthy()
    await act(async () => {
      dismiss.click()
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('CallRise now keeps itself up to date')
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ autoUpdateNoticePending: false })
    const patch = update.mock.calls[0][0]
    expect('autoUpdateEnabled' in patch).toBe(false)
  })

  it('does not render at all once dismissed (real settings, so once per install)', async () => {
    pending = false
    await mount()
    expect(container.textContent).toBe('')
  })
})
