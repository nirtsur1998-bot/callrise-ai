// @vitest-environment happy-dom
//
// M26 Phase 4.5.2 — useDealIntelligenceSettings moved from renderer-only
// localStorage to main's AppSettings (app-settings.ts's dealIntelligence
// field), read/written through window.api.settings.get()/update(). These
// tests drive the REAL hook through a minimal consumer component, with only
// window.api mocked.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useDealIntelligenceSettings,
  type DealIntelligenceSettings
} from '../useDealIntelligenceSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Consumer({
  onApi
}: {
  onApi: (api: DealIntelligenceSettings) => void
}): null {
  onApi(useDealIntelligenceSettings())
  return null
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function mockSettings(dealIntelligence: unknown): { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => ({ dealIntelligence }))
  const update = vi.fn(async (patch: unknown) => ({ ok: true, patch }))
  ;(window as unknown as { api: unknown }).api = { settings: { get, update } }
  return { get, update }
}

describe('useDealIntelligenceSettings', () => {
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

  it('shows the safe local defaults (off, balanced, all types on) before the real value loads', () => {
    mockSettings({
      enabled: true,
      sensitivity: 'aggressive',
      enabledTypes: { risk: true, opportunity: false, tactical: true },
      frequency: 'frequent'
    })
    let api!: DealIntelligenceSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    expect(api.enabled).toBe(false) // Beta — off by default, matches EMPTY_DEAL_INTELLIGENCE
    expect(api.sensitivity).toBe('balanced')
    expect(api.enabledTypes).toEqual({ risk: true, opportunity: true, tactical: true })
    expect(api.frequency).toBe('balanced')
  })

  it('loads the real value from window.api.settings.get() once it resolves', async () => {
    const { get } = mockSettings({
      enabled: true,
      sensitivity: 'aggressive',
      enabledTypes: { risk: true, opportunity: false, tactical: true },
      frequency: 'frequent'
    })
    let api!: DealIntelligenceSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()
    expect(get).toHaveBeenCalledTimes(1)
    expect(api.enabled).toBe(true)
    expect(api.sensitivity).toBe('aggressive')
    expect(api.enabledTypes).toEqual({ risk: true, opportunity: false, tactical: true })
    expect(api.frequency).toBe('frequent')
  })

  it('setEnabled/setSensitivity/setFrequency each write through settings.update with the dealIntelligence shape', async () => {
    const { update } = mockSettings({
      enabled: false,
      sensitivity: 'balanced',
      enabledTypes: { risk: true, opportunity: true, tactical: true },
      frequency: 'balanced'
    })
    let api!: DealIntelligenceSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()

    act(() => api.setEnabled(true))
    expect(update).toHaveBeenLastCalledWith({ dealIntelligence: { enabled: true } })

    act(() => api.setSensitivity('quiet'))
    expect(update).toHaveBeenLastCalledWith({ dealIntelligence: { sensitivity: 'quiet' } })

    act(() => api.setFrequency('infrequent'))
    expect(update).toHaveBeenLastCalledWith({ dealIntelligence: { frequency: 'infrequent' } })
  })

  it('setTypeEnabled writes a single-key enabledTypes patch, not the whole map', async () => {
    const { update } = mockSettings({
      enabled: true,
      sensitivity: 'balanced',
      enabledTypes: { risk: true, opportunity: true, tactical: true },
      frequency: 'balanced'
    })
    let api!: DealIntelligenceSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()

    act(() => api.setTypeEnabled('risk', false))
    expect(update).toHaveBeenLastCalledWith({ dealIntelligence: { enabledTypes: { risk: false } } })
  })

  it('setTypeEnabled refuses to disable the last remaining enabled type, and does not call update at all', async () => {
    const { update } = mockSettings({
      enabled: true,
      sensitivity: 'balanced',
      enabledTypes: { risk: false, opportunity: false, tactical: true },
      frequency: 'balanced'
    })
    let api!: DealIntelligenceSettings
    root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer, { onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()
    update.mockClear()

    act(() => api.setTypeEnabled('tactical', false))
    expect(update).not.toHaveBeenCalled()
    expect(api.enabledTypes).toEqual({ risk: false, opportunity: false, tactical: true })
  })
})
