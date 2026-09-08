// @vitest-environment happy-dom
//
// Sentence C, RENDERED — the one of round five's three that the VM walk could
// not show on screen.
//
// WHY A TEST AND NOT A SCREENSHOT. On the VM the diagnostics log held 26 sent
// events, so the empty-state branch was structurally unreachable there: the
// screen showed "The last 26 events that left this computer", which is the
// other branch and correct. "Not rendering" and "wrong branch showing" are
// different findings and only one of them is a bug. Emptying that log to force
// the branch would have been a one-off proof that nothing preserves; this
// asserts the same thing permanently, in both directions.
//
// The sentence replaced "Nothing has been sent from this computer." — worded
// absolutely on a privacy screen while scoped by its surroundings to
// diagnostics, and false inside its own scope too: the sent log is
// user-deletable from that very card, so pressing Delete made the app claim
// nothing was ever sent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { TelemetrySection } from '../TelemetrySection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Sent = { sentAt: string; status: number | null; count: number; body: string }

function installApi(sent: Sent[]): void {
  ;(window as unknown as Record<string, unknown>).api = {
    telemetry: {
      getState: vi.fn(async () => ({
        consent: { consent: 'on', decidedAt: '2026-09-01T00:00:00.000Z' },
        installId: 'test-install-id',
        queued: [],
        sent,
        lastResult: null
      })),
      setConsent: vi.fn(async () => ({
        consent: { consent: 'on' },
        installId: 'x',
        queued: [],
        sent,
        lastResult: null
      })),
      flush: vi.fn(async () => ({ attempted: false, sent: 0 })),
      clearQueue: vi.fn(async () => true),
      clearSent: vi.fn(async () => true)
    }
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(): Promise<string> {
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(TelemetrySection))
  })
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  return container.textContent ?? ''
}

const oneBatch: Sent[] = [
  { sentAt: '2026-09-08T10:00:00.000Z', status: 200, count: 3, body: '{"events":[]}' }
]

describe('the diagnostics log says which kind of empty it is', () => {
  it('an EMPTY log says it is empty and says since when — sentence C', async () => {
    installApi([])
    const text = await render()
    expect(text).toContain('This log is empty — no diagnostics have been sent since it was last cleared.')
  })

  it('and never claims nothing was ever sent', async () => {
    // The exact regression. The old sentence was absolute, on a privacy screen,
    // and false the moment someone pressed Delete on this same card.
    installApi([])
    const text = await render()
    expect(text).not.toContain('Nothing has been sent from this computer')
  })

  it('a NON-empty log reports the count instead — the branch the VM was showing', async () => {
    installApi(oneBatch)
    const text = await render()
    expect(text).toContain('The last 1 event that left this computer')
    expect(text).not.toContain('This log is empty')
  })
})
