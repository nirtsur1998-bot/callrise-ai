// @vitest-environment happy-dom
//
// BUG-270 — instances of useCueSettings must see each other's writes.
//
// Driven on 2026-09-14 in a branch build: "Turn off" on the Live banner (the
// Provider's instance) wrote `clientContext: false` to disk while the Voice AI
// panel's own instance kept its switch ON. Two surfaces, one setting, two
// answers — on the switch that decides whether a buyer's earlier words leave
// the machine. These tests mount TWO consumers and assert that a write through
// one is visible on the other, for the consent-class switch and for the mute.
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

describe('useCueSettings — two instances stay in step (BUG-270)', () => {
  let container: HTMLDivElement
  let root: Root
  let update: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const get = vi.fn(async () => ({
      liveCues: { enabled: true, sensitivity: 'low', quiet: false, clientContext: true }
    }))
    update = vi.fn(async (patch: unknown) => ({ ok: true, patch }))
    ;(window as unknown as { api: unknown }).api = { settings: { get, update } }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  function mountTwo(): { a: () => CueSettings; b: () => CueSettings } {
    let a!: CueSettings
    let b!: CueSettings
    root = createRoot(container)
    act(() => {
      root.render(
        createElement('div', null, [
          createElement(Consumer, { key: 'a', onApi: (x) => (a = x) }),
          createElement(Consumer, { key: 'b', onApi: (x) => (b = x) })
        ])
      )
    })
    return { a: () => a, b: () => b }
  }

  it('the banner turning clientContext OFF is seen by the panel, and written once', async () => {
    const { a, b } = mountTwo()
    await flushMicrotasks()
    expect(a().clientContext).toBe(true)
    expect(b().clientContext).toBe(true)

    act(() => a().setClientContext(false))

    expect(a().clientContext).toBe(false)
    expect(b().clientContext).toBe(false) // the other instance, same tick
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ liveCues: { clientContext: false } })
  })

  it('the mute flipped in one place is seen in the other too', async () => {
    const { a, b } = mountTwo()
    await flushMicrotasks()
    act(() => b().setEnabled(false))
    expect(a().enabled).toBe(false)
    expect(b().enabled).toBe(false)
  })

  it('an instance that mounts AFTER a write converges once its own load lands', async () => {
    const { a } = mountTwo()
    await flushMicrotasks()
    act(() => a().setClientContext(false))
    // A later mount loads from main; main (mocked here) still says true, and
    // that is what it must show — the store is a relay, not a second source
    // of truth. (Main's value would be false in the app, because the write
    // above reached it.)
    let c!: CueSettings
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const root2 = createRoot(holder)
    act(() => {
      root2.render(createElement(Consumer, { onApi: (x) => (c = x) }))
    })
    await flushMicrotasks()
    expect(c.clientContext).toBe(true)
    act(() => root2.unmount())
    holder.remove()
  })
})
