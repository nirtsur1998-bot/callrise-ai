// @vitest-environment happy-dom
//
// M29 A1.3 — the one-time ask. Rendered through the real React stack against
// a stubbed window.api. Proves: shown only while 'unasked'; both answers call
// setConsent with the right value and the card disappears; nothing is called
// until the user clicks.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryAskCard } from '../TelemetryAskCard'
import { SETTINGS_GROUPS, ALL_SETTINGS_PAGES } from '@renderer/features/settings/settings-nav'

let root: Root | null = null
let container: HTMLDivElement
let consent: 'on' | 'off' | 'unasked'
const setConsent = vi.fn(async (v: 'on' | 'off') => {
  consent = v
  return { consent: { consent: v }, anonId: v === 'on' ? 'id' : null, queued: [], sent: [] }
})

function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    telemetry: {
      getState: () => Promise.resolve({ consent: { consent }, anonId: null, queued: [], sent: [] }),
      setConsent,
      clearQueue: () =>
        Promise.resolve({ consent: { consent }, anonId: null, queued: [], sent: [] })
    }
  }
}

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(TelemetryAskCard, { onNavigate: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  setConsent.mockClear()
  consent = 'unasked'
  stubApi()
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

describe('TelemetryAskCard', () => {
  it('renders the honest copy while unasked, and calls nothing until clicked', async () => {
    await mount()
    expect(container.textContent).toContain('Help find crashes?')
    expect(container.textContent).toContain('Never sends')
    expect(container.textContent).toContain('Transcripts, recordings')
    expect(setConsent).not.toHaveBeenCalled()
  })

  it.each([
    ['Yes, send anonymous diagnostics', 'on'],
    ['No thanks', 'off']
  ] as const)('"%s" records %s and hides the card', async (label, expected) => {
    await mount()
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label
    )
    expect(button, label).toBeDefined()
    await act(async () => {
      button!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(setConsent).toHaveBeenCalledTimes(1)
    expect(setConsent).toHaveBeenCalledWith(expected)
    expect(container.textContent).not.toContain('Help find crashes?')
  })

  it.each(['on', 'off'] as const)(
    'does not render at all once the device has answered (%s)',
    async (decided) => {
      consent = decided
      await mount()
      expect(container.textContent).toBe('')
    }
  )
})

describe('Settings navigation', () => {
  it('lists Diagnostics & telemetry under Privacy, after Privacy & data', () => {
    const privacy = SETTINGS_GROUPS.find((g) => g.label === 'Privacy')
    expect(privacy?.items.map((i) => i.id)).toEqual(['privacy-data', 'telemetry'])
    expect(ALL_SETTINGS_PAGES.find((p) => p.id === 'telemetry')?.label).toBe(
      'Diagnostics & telemetry'
    )
  })
})
