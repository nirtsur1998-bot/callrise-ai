// @vitest-environment happy-dom
//
// M36 Stage 1 — the sample call, mounted for real. The Stage 2 walk's
// stranger reached a live view that could do nothing without a key; these
// pin the two doors that now lead somewhere (Home's card, the no-key
// state's second button) and that the sample never pretends to be the
// user's data.
import { vi } from 'vitest'
// lib/platform.ts reads window.api.platform at import time; happy-dom has no
// preload bridge, so the stub must exist before any module below loads.
vi.hoisted(() => {
  ;(globalThis as unknown as { window: { api?: unknown } }).window.api = {
    platform: 'win32',
    transcription: { openMicSettings: async () => undefined }
  }
})
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SampleCallView } from '../SampleCallView'
import { SampleCallCard } from '../SampleCallCard'
import { NoKeyState } from '@renderer/features/live/components/LiveStates'
import { SAMPLE_SEGMENTS, isSampleCallSeen } from '../sampleCall'

let roots: Root[] = []
function mount(el: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(el))
  return container
}

beforeEach(() => {
  roots = []
  localStorage.clear()
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  document.body.innerHTML = ''
})

describe('SampleCallView', () => {
  it('renders every transcript turn, says it is a sample, and stores nothing but the seen flag', () => {
    const c = mount(createElement(SampleCallView, { onStartCall: () => {}, onAddKey: () => {} }))
    const text = c.textContent ?? ''
    expect(text).toContain('This is a sample call.')
    for (const seg of SAMPLE_SEGMENTS) expect(text).toContain(seg.text.slice(0, 40))
    expect(text).toContain('What you would have seen live')
    expect(text).toContain('not produced by a model')
    expect(text).toContain('written by hand for the sample')
    expect(isSampleCallSeen()).toBe(true)
    expect(Object.keys(localStorage).filter((k) => k !== 'callrise.sampleCall.seen')).toEqual([])
  })
  it('its two exits call the navigation the shell wires', () => {
    const start = vi.fn()
    const key = vi.fn()
    const c = mount(createElement(SampleCallView, { onStartCall: start, onAddKey: key }))
    const buttons = Array.from(c.querySelectorAll('button'))
    act(() => buttons.find((b) => /Start my first call/.test(b.textContent ?? ''))!.click())
    act(() => buttons.find((b) => /Add a key/.test(b.textContent ?? ''))!.click())
    expect(start).toHaveBeenCalledTimes(1)
    expect(key).toHaveBeenCalledTimes(1)
  })
})

describe('SampleCallCard on Home', () => {
  it('shows until the sample has been seen, then not at all', () => {
    const nav = vi.fn()
    const c = mount(createElement(SampleCallCard, { onNavigate: nav }))
    expect(c.querySelector('[data-testid="sample-call-card"]')).not.toBeNull()
    act(() => Array.from(c.querySelectorAll('button')).find((b) => /Open the sample/.test(b.textContent ?? ''))!.click())
    expect(nav).toHaveBeenCalledWith('sample-call')
    localStorage.setItem('callrise.sampleCall.seen', '1')
    const again = mount(createElement(SampleCallCard, { onNavigate: nav }))
    expect(again.querySelector('[data-testid="sample-call-card"]')).toBeNull()
  })
})

describe('NoKeyState', () => {
  it('offers the sample only when the parent can navigate to it', () => {
    const without = mount(createElement(NoKeyState, { onRetry: () => {} }))
    expect(without.textContent).not.toContain('See a sample call instead')
    const onSample = vi.fn()
    const withIt = mount(createElement(NoKeyState, { onRetry: () => {}, onSample }))
    const btn = Array.from(withIt.querySelectorAll('button')).find((b) => /See a sample call instead/.test(b.textContent ?? ''))
    expect(btn).toBeTruthy()
    act(() => btn!.click())
    expect(onSample).toHaveBeenCalledTimes(1)
  })
})
