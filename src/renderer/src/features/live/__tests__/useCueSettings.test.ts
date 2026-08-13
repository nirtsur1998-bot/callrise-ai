// @vitest-environment happy-dom
//
// M26 Phase 4.5.2 — useCueSettings moved from renderer-only localStorage to
// main's AppSettings (app-settings.ts's liveCues field), read/written
// through window.api.settings.get()/update(). These tests drive the REAL
// hook through a minimal consumer component, with only window.api mocked.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCueSettings, type CueSettings } from '../useCueSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Consumer({ onApi }: { onApi: (api: CueSettings) => void }): null {
  onApi(useCueSettings())
  return null
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useCueSettings', () => {
  let container: HTMLDivElement
  let root: Root
  let get: ReturnType<typeof vi.fn>
  let update: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    get = vi.fn(async () => ({ liveCues: { enabled: false, sensitivity: 'high' } }))
    update = vi.fn(async (patch: unknown) => ({ ok: true, patch }))
    ;(window as unknown as { api: unknown }).api = { settings: { get, update } }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  it('shows the safe local default before the real value loads', () => {
    let api!: CueSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    expect(api.enabled).toBe(true) // default ON, matches app-settings.ts's EMPTY_LIVE_CUES
    expect(api.sensitivity).toBe('low')
  })

  it('loads the real value from window.api.settings.get() once it resolves', async () => {
    let api!: CueSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()
    expect(get).toHaveBeenCalledTimes(1)
    expect(api.enabled).toBe(false)
    expect(api.sensitivity).toBe('high')
  })

  it('setEnabled writes through window.api.settings.update with the liveCues shape', async () => {
    let api!: CueSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()

    act(() => api.setEnabled(false))
    expect(update).toHaveBeenCalledWith({ liveCues: { enabled: false } })
    await flushMicrotasks()
    expect(api.enabled).toBe(false)
  })

  it('setSensitivity writes through window.api.settings.update with the liveCues shape', async () => {
    let api!: CueSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()

    act(() => api.setSensitivity('medium'))
    expect(update).toHaveBeenCalledWith({ liveCues: { sensitivity: 'medium' } })
  })

  it('a failed settings.get() leaves the safe local default in place rather than throwing', async () => {
    get.mockRejectedValueOnce(new Error('ipc unavailable'))
    let api!: CueSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()
    expect(api.enabled).toBe(true)
    expect(api.sensitivity).toBe('low')
  })
})
