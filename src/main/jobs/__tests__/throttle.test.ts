import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { throttle } from '../throttle'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('throttle', () => {
  it('fires the first call immediately', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t.call('a')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('a')
  })

  it('coalesces a burst within the interval into ONE trailing call, not one per call', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t.call(1)
    t.call(2)
    t.call(3)
    t.call(4)
    expect(fn).toHaveBeenCalledTimes(1) // only the leading call so far

    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2) // exactly one trailing call for the whole burst
    expect(fn).toHaveBeenLastCalledWith(4) // always the LATEST args, never a stale middle one
  })

  it('never exceeds ~4/sec under a continuous hot loop', () => {
    const fn = vi.fn()
    const t = throttle(fn, 250) // 250ms => max 4/sec
    for (let ms = 0; ms < 2000; ms += 10) {
      t.call(ms)
      vi.advanceTimersByTime(10)
    }
    // 2000ms of continuous calls at a 250ms floor => at most 8 deliveries,
    // never anywhere near the ~200 calls actually made.
    expect(fn.mock.calls.length).toBeLessThanOrEqual(9)
    expect(fn.mock.calls.length).toBeGreaterThan(0)
  })

  it('fires again promptly once the burst ends and the interval has passed', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t.call('a')
    vi.advanceTimersByTime(150) // well clear of the interval, no more calls made
    t.call('b')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('b')
  })

  it('cancel() drops a pending trailing call', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t.call('a')
    t.call('b') // queued as trailing
    t.cancel()
    vi.advanceTimersByTime(200)
    expect(fn).toHaveBeenCalledTimes(1) // only the original leading call
  })
})

describe('throttle({ leading: false })', () => {
  it('never fires synchronously, even for the very first call', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100, { leading: false })
    t.call('a')
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('a')
  })

  it('cancel() is then a real guarantee — nothing can already be "in flight"', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100, { leading: false })
    t.call('a')
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled() // unlike the leading:true case, there is no earlier call to race
  })

  it('still coalesces a burst into one trailing call with the latest args', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100, { leading: false })
    t.call(1)
    t.call(2)
    t.call(3)
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })
})
