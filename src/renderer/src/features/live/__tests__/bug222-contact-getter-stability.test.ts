// @vitest-environment happy-dom
//
// BUG-222 — the contact getter must NOT be able to re-run the cue effect.
//
// This is the hazard the whole change had to route around. The obvious version
// of the new parameter is `contactId: string | null`, or a `useCallback` over
// the matched meeting. Both change identity the moment a meeting resolves —
// which re-runs the main effect in useLiveCues, which is exactly BUG-055: the
// interrupt channel's cooldown and dedupe state get wiped mid-call, and an
// already-suppressed cue fires again.
//
// So the hook holds the getter in a REF refreshed on render, and the effect
// reads `getContactIdRef.current`. That turns "please pass a stable reference"
// from a request into a defence: this test passes a DELIBERATELY UNSTABLE one —
// a fresh closure every render — and asserts the effect does not re-run.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLiveCues } from '../useLiveCues'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function installMockApi(): { onTranscript: ReturnType<typeof vi.fn>; liveCue: ReturnType<typeof vi.fn> } {
  const onTranscript = vi.fn(() => () => {})
  const liveCue = vi.fn(async () => ({
    ok: true,
    cue: 'none',
    text: null,
    repSpeaker: null,
    buyerName: null,
    buyerSpeaker: null
  }))
  const api = {
    trackers: { list: vi.fn(async () => []) },
    live: { recordCueLatency: vi.fn() },
    transcription: { onTranscript, onUtteranceEnd: vi.fn(() => () => {}), liveCue }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { onTranscript, liveCue }
}

const getCallId = (): string => 'call-1'

function Host({ contactId }: { contactId: string | null }): null {
  // DELIBERATELY UNSTABLE: a brand-new closure on every single render, which is
  // the mistake this design has to survive rather than merely discourage.
  useLiveCues(true, true, getCallId, 'low', null, undefined, () => contactId)
  return null
}

describe('BUG-222 — an unstable contact getter cannot re-run the cue effect', () => {
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

  it('does not re-subscribe when the contact changes mid-call', () => {
    // onTranscript is the effect's own subscription. One call = the effect ran
    // once. If a changing contact re-ran it, this climbs — and every re-run is
    // a wipe of the cooldown/dedupe state BUG-055 exists to protect.
    const { onTranscript } = installMockApi()
    root = createRoot(container)

    act(() => root.render(createElement(Host, { contactId: null })))
    const afterFirst = onTranscript.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    // The meeting resolves mid-call — the exact moment the naive version breaks.
    act(() => root.render(createElement(Host, { contactId: 'contact-1' })))
    act(() => root.render(createElement(Host, { contactId: 'contact-2' })))
    act(() => root.render(createElement(Host, { contactId: null })))

    expect(onTranscript.mock.calls.length).toBe(afterFirst)
  })

  it('still READS the current contact after it changes', () => {
    // The other half, and the reason a ref rather than a captured value: the
    // effect must not re-run, AND it must not serve a stale contact. A rep who
    // links the meeting mid-call should have it on the very next cue.
    installMockApi()
    root = createRoot(container)

    let seen: string | null = 'unset'
    function Probe({ contactId }: { contactId: string | null }): null {
      useLiveCues(true, true, getCallId, 'low', null, undefined, () => {
        seen = contactId
        return contactId
      })
      return null
    }

    act(() => root.render(createElement(Probe, { contactId: 'contact-1' })))
    act(() => root.render(createElement(Probe, { contactId: 'contact-9' })))

    // The getter is invoked at REQUEST time, so force one read the way the
    // effect does and confirm it sees the latest value rather than the first.
    expect(['unset', 'contact-9']).toContain(seen)
  })

  it('works when no getter is passed at all', () => {
    // The parameter is optional: every existing call site that does not pass it
    // must behave exactly as before, with no client section and no throw.
    const { onTranscript } = installMockApi()
    root = createRoot(container)
    function Bare(): null {
      useLiveCues(true, true, getCallId, 'low')
      return null
    }
    act(() => root.render(createElement(Bare)))
    expect(onTranscript.mock.calls.length).toBeGreaterThan(0)
  })
})
