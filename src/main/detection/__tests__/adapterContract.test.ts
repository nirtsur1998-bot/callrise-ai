import { describe, expect, it, vi } from 'vitest'
import { NullAdapter } from '../adapters/NullAdapter'
import type { ICallDetectorAdapter } from '../adapters/ICallDetectorAdapter'
import { MacAdapter } from '../adapters/MacAdapter'
import type { DetectionSignal } from '../types'

/** Every adapter (Mac/Windows/Null) must satisfy this, regardless of platform specifics. */
function runAdapterContractTests(label: string, makeAdapter: () => ICallDetectorAdapter): void {
  describe(`ICallDetectorAdapter contract: ${label}`, () => {
    it('isSupported() returns a boolean without throwing', () => {
      const adapter = makeAdapter()
      expect(typeof adapter.isSupported()).toBe('boolean')
    })

    it('start() then stop() does not throw', () => {
      const adapter = makeAdapter()
      expect(() => adapter.start()).not.toThrow()
      expect(() => adapter.stop()).not.toThrow()
    })

    it('start()/stop() is idempotent - calling either twice in a row does not throw', () => {
      const adapter = makeAdapter()
      adapter.start()
      expect(() => adapter.start()).not.toThrow()
      adapter.stop()
      expect(() => adapter.stop()).not.toThrow()
    })

    it('onSignal returns a working unsubscribe function', () => {
      const adapter = makeAdapter()
      const callback = vi.fn()
      const unsubscribe = adapter.onSignal(callback)
      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
      adapter.stop()
    })
  })
}

runAdapterContractTests('NullAdapter', () => new NullAdapter())

describe('NullAdapter-specific behavior', () => {
  it('only delivers emitted signals to listeners after start()', () => {
    const adapter = new NullAdapter()
    const received: DetectionSignal[] = []
    adapter.onSignal((s) => received.push(s))

    const signal: DetectionSignal = {
      kind: 'process',
      appId: 'zoom',
      displayName: 'Zoom',
      observedAt: 1,
      weight: 0
    }
    adapter.emit(signal) // not started yet - should be dropped
    expect(received).toHaveLength(0)

    adapter.start()
    adapter.emit(signal)
    expect(received).toEqual([signal])

    adapter.stop()
  })
})

// MacAdapter loads a real compiled native addon - only meaningful on darwin, and only
// after `npm run native:build:mac` has produced the .node binary. Skips cleanly
// everywhere else rather than failing CI on Linux/Windows.
const macDescribe = process.platform === 'darwin' ? describe : describe.skip
macDescribe('MacAdapter (darwin only)', () => {
  runAdapterContractTests('MacAdapter', () => new MacAdapter())

  it('reports whether the native addon loaded, without throwing either way', () => {
    const adapter = new MacAdapter()
    // isSupported() reflects whether native/mac-audio-activity/build/Release/mac_audio_activity.node
    // was found and loaded - false (not a failure) if it hasn't been built yet.
    expect(typeof adapter.isSupported()).toBe('boolean')
  })
})
