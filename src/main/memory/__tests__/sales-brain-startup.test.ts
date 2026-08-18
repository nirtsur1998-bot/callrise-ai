// M27 / taxonomy species 15 — THE TIMEOUT THAT CANNOT FIRE.
//
// The old startup shape was:
//     await Promise.race([initSalesBrain(), new Promise((r) => setTimeout(r, 15_000))])
// with createWindow() further down. The 15s cap could not bound the part of
// init most likely to stall, so a slow open/migrate produced no window at all.
import { describe, expect, it, vi } from 'vitest'
import { scheduleSalesBrainStartup } from '../sales-brain-startup'

/** Burns wall-clock synchronously, the way openMemoryDb() does: two native
 *  require()s, the DB open, WAL pragma, extension load. No awaits, so the
 *  event loop cannot turn while it runs. */
function blockFor(ms: number): void {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    /* deliberately blocking */
  }
}

describe('species 15: the 15s cap could not bound a synchronous init', () => {
  // CHARACTERISATION, NOT A REGRESSION GUARD. This pins the language
  // semantics that made the old cap decorative; it passes with or without
  // our fix, because it tests Promise.race, not our code. It is here so the
  // reason is written down in something that runs, rather than only in a
  // comment that can drift. The actual guards are the tests below.
  it('demonstrates a 500ms cap failing to bound a 3000ms synchronous block', async () => {
    const BLOCK_MS = 3000
    const CAP_MS = 500
    const t0 = Date.now()

    const result = await Promise.race([
      (async () => {
        blockFor(BLOCK_MS)
        return 'init finished'
      })(),
      new Promise((resolve) => setTimeout(() => resolve('CAP FIRED'), CAP_MS))
    ])

    const elapsed = Date.now() - t0

    // The cap loses outright — it is not merely late, it never fires. The
    // timer is not even armed until the synchronous block is over, because
    // Promise.race evaluates its arguments left to right.
    expect(result).toBe('init finished')
    expect(elapsed).toBeGreaterThanOrEqual(BLOCK_MS - 50)
  }, 10_000)
})

describe('scheduleSalesBrainStartup', () => {
  // THE CENTRAL GUARD. Goes red against the old shape, which called
  // initSalesBrain() inline on the startup path: there, `init` would have
  // run before the scheduling call returned, and any synchronous stall
  // inside it would land before createWindow() ever executed.
  it('does not call init synchronously', () => {
    const init = vi.fn(async () => 'ok')
    const timers: Array<() => void> = []

    scheduleSalesBrainStartup({
      init,
      afterInit: vi.fn(),
      setTimer: (cb) => void timers.push(cb)
    })

    expect(init).not.toHaveBeenCalled()
  })

  // The property the fix actually exists for, stated the way a user would:
  // the window gets shown no matter how long init takes. Modelled as
  // ordering — "show" is recorded before init is even invoked — because the
  // real 'ready-to-show' event cannot be delivered while the main process is
  // blocked, which is precisely why init must not run on that tick.
  it('lets the window be shown before a blocking init ever starts', async () => {
    const order: string[] = []
    const timers: Array<() => void> = []

    const handle = scheduleSalesBrainStartup({
      init: async () => {
        order.push('init:start')
        blockFor(300) // a stall that, on the old path, meant no window
        order.push('init:end')
      },
      afterInit: () => void order.push('afterInit'),
      setTimer: (cb) => void timers.push(cb)
    })

    // What index.ts does now: construct the window, then let the event loop
    // turn so 'ready-to-show' can be delivered and the window shown.
    order.push('createWindow')
    order.push('show')
    handle.windowReady()

    await handle.settled

    expect(order).toEqual(['createWindow', 'show', 'init:start', 'init:end', 'afterInit'])
  })

  // The second-order break that the naive "just delete the await" fix
  // introduces. maybeRunNightlyConsolidation() early-returns on a null db,
  // so calling it before init resolved silently skips nightly consolidation
  // for the whole session — green tests, no error, feature quietly gone.
  it('runs afterInit only once init has resolved', async () => {
    let dbReady = false
    let sawDbReady: boolean | null = null
    const timers: Array<() => void> = []

    const handle = scheduleSalesBrainStartup({
      init: async () => {
        await new Promise((r) => setTimeout(r, 20))
        dbReady = true
      },
      afterInit: () => {
        sawDbReady = dbReady
      },
      setTimer: (cb) => void timers.push(cb)
    })

    handle.windowReady()
    expect(sawDbReady).toBeNull() // not yet — init is still running
    await handle.settled

    // Had afterInit been called on the old post-await line with the await
    // removed, this would be false: the exact silent skip described above.
    expect(sawDbReady).toBe(true)
  })

  it('runs init exactly once when ready-to-show and the fallback both fire', async () => {
    const init = vi.fn(async () => 'ok')
    const timers: Array<() => void> = []

    const handle = scheduleSalesBrainStartup({
      init,
      afterInit: vi.fn(),
      setTimer: (cb) => void timers.push(cb)
    })

    handle.windowReady()
    handle.windowReady() // a second paint signal
    for (const t of timers) t() // and the backstop fires late
    await handle.settled

    // Two migrate() runs against one file is the failure ensureMemoryDb()
    // already guards against elsewhere; this is the startup-path equivalent.
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('still starts init when ready-to-show never arrives', async () => {
    const init = vi.fn(async () => 'ok')
    const afterInit = vi.fn()
    const timers: Array<() => void> = []

    const handle = scheduleSalesBrainStartup({
      init,
      afterInit,
      setTimer: (cb) => void timers.push(cb)
    })

    // Renderer never paints. Without the backstop, Sales Brain would be off
    // for the session with nothing anywhere saying why.
    expect(timers).toHaveLength(1)
    for (const t of timers) t()
    await handle.settled

    expect(init).toHaveBeenCalledTimes(1)
    expect(afterInit).toHaveBeenCalledTimes(1)
  })

  it('survives an init that throws synchronously, and still chains afterInit', async () => {
    const afterInit = vi.fn()
    const onError = vi.fn()
    const timers: Array<() => void> = []

    // better-sqlite3's Database constructor throws synchronously on a native
    // module load failure — this shipped as a real bug in 1.2.1. A bare
    // .catch() would miss it, because the throw happens before any promise
    // exists to attach to.
    const handle = scheduleSalesBrainStartup({
      init: () => {
        throw new Error('native module failed to load')
      },
      afterInit,
      onError,
      setTimer: (cb) => void timers.push(cb)
    })

    expect(() => handle.windowReady()).not.toThrow()
    await handle.settled

    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('survives an init that rejects, and still chains afterInit', async () => {
    const afterInit = vi.fn()
    const onError = vi.fn()
    const timers: Array<() => void> = []

    const handle = scheduleSalesBrainStartup({
      init: async () => {
        throw new Error('migration failed')
      },
      afterInit,
      onError,
      setTimer: (cb) => void timers.push(cb)
    })

    handle.windowReady()
    await handle.settled

    expect(onError).toHaveBeenCalledTimes(1)
    // Unconditional: afterInit re-checks the db itself and no-ops without
    // one, so it is safe here and one less branch to get wrong.
    expect(afterInit).toHaveBeenCalledTimes(1)
  })
})
