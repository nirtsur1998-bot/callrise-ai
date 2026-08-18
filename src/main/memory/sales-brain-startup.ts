// M27 — how Sales Brain init is scheduled during app startup.
//
// Extracted from index.ts purely to make the ORDERING testable. index.ts is
// the electron entry point (it calls app.whenReady() at module load), so
// nothing in the suite imports it and its startup sequence has never had a
// test. The ordering here is the part that has now broken in production
// twice, so it gets a seam.
//
// ── What this replaced, and why (taxonomy species 15) ────────────────────
//
// The old shape:
//
//     await Promise.race([initSalesBrain(), new Promise((r) => setTimeout(r, 15_000))])
//
// read as "Sales Brain gets 15 seconds, then we move on." It could not do
// that. Promise.race evaluates its arguments left to right: initSalesBrain()
// is CALLED FIRST and runs to its first real `await` before the second
// argument exists, so the 15s timer is not even armed until the synchronous
// part is already over. And openMemoryDb() is entirely synchronous — two
// native-module require()s, the database open, a WAL pragma, an extension
// load — with the only genuine await (db.backup()) reached later, and only on
// a file that actually needs migrating. Even once armed, the timer cannot
// fire while synchronous migration statements hold the event loop.
//
// So the cap bounded almost nothing, and because createWindow() ran after it,
// the stall it existed to survive produced NO WINDOW AT ALL — the same
// signature as the silent-launch-failure bug, and the shape of the ~48s
// production stall documented in index.ts's own comment.
//
// The cap is gone rather than relabelled. An honest label on a guard that
// cannot fire still leaves dead code implying a bound exists.
//
// ── Why "createWindow() first" is necessary but NOT sufficient ───────────
//
// The window is constructed with `show: false` and shown from its
// 'ready-to-show' event. Delivering that event requires the main process
// event loop to turn. Calling a synchronously-blocking init immediately
// after createWindow(), on the same tick, therefore still leaves the user
// staring at nothing — the window object exists and is never shown.
//
// Hence: init starts only once the window is actually on screen. The
// fallback timer exists because 'ready-to-show' is not guaranteed — a
// renderer that fails to paint would otherwise strand Sales Brain off
// permanently, turning a visible startup stall into a silent missing feature.

/** Long enough that the fallback loses the race on any normal launch (so init
 *  really does start after paint), short enough that a renderer which never
 *  paints doesn't strand Sales Brain for the whole session. CHOSEN, not
 *  measured — there is no field data on ready-to-show latency. It is a
 *  backstop for a path that should not happen, not a tuned budget, and
 *  nothing about correctness depends on the exact number: whichever trigger
 *  arrives first wins, and the other is ignored. */
export const READY_FALLBACK_MS = 10_000

export interface SalesBrainStartupOptions {
  /** initSalesBrain(). May block synchronously and may throw synchronously —
   *  both are the documented real-world behaviours (better-sqlite3's
   *  constructor throws on a native-module load failure). */
  init: () => Promise<unknown>
  /** maybeRunNightlyConsolidation(). Runs after init settles, NOT after the
   *  scheduling call returns: it early-returns on a null db, so calling it
   *  before init finished would silently skip nightly consolidation for the
   *  entire session. That is the second-order break un-awaiting invites, and
   *  it is what the chaining below exists to prevent. */
  afterInit: () => void
  /** Injected for tests; defaults to the real timer. */
  setTimer?: (cb: () => void, ms: number) => void
  fallbackMs?: number
  onError?: (err: unknown) => void
}

export interface SalesBrainStartupHandle {
  /** Call from the window's 'ready-to-show' handler, after show(). Safe to
   *  call more than once, and safe to never call. */
  windowReady: () => void
  /** Resolves once init has settled and afterInit has run. For tests and for
   *  anything that legitimately needs to wait; startup itself never does. */
  settled: Promise<void>
}

/**
 * Schedules Sales Brain init to begin AFTER the window is on screen, and
 * chains nightly consolidation behind it.
 *
 * Never awaited by startup, never throws, and — the property that matters —
 * never calls `init` synchronously. A caller can return immediately and let
 * the event loop deliver 'ready-to-show' no matter how slow or blocking init
 * turns out to be.
 */
export function scheduleSalesBrainStartup(
  opts: SalesBrainStartupOptions
): SalesBrainStartupHandle {
  const {
    init,
    afterInit,
    setTimer = (cb, ms) => {
      const t = setTimeout(cb, ms)
      // Don't hold the process open on this backstop alone.
      if (typeof t === 'object' && t !== null && 'unref' in t) t.unref()
    },
    fallbackMs = READY_FALLBACK_MS,
    onError = (err) =>
      console.error('[sales-brain] init failed at startup, disabled for this session:', err)
  } = opts

  let started = false
  let resolveSettled: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })

  const begin = (): void => {
    // Whichever trigger arrives first wins; the other becomes a no-op. Both
    // fire on a slow-but-eventually-painting renderer, and running the
    // migration twice against the same file is exactly the kind of thing
    // ensureMemoryDb() already goes out of its way to avoid.
    if (started) return
    started = true

    // try/catch around the CALL, not just the promise: initSalesBrain() can
    // throw synchronously before ever returning a promise, so a bare
    // .catch() would miss it. index.ts has always wrapped this call for that
    // reason; the wrapper moves here with it.
    let promise: Promise<unknown>
    try {
      promise = Promise.resolve(init())
    } catch (err) {
      onError(err)
      resolveSettled()
      return
    }

    void promise
      .catch((err: unknown) => {
        onError(err)
      })
      .then(() => {
        // Runs even when init failed: afterInit re-checks the db itself and
        // no-ops when there isn't one, so calling it unconditionally is both
        // harmless and one less branch to get wrong.
        try {
          afterInit()
        } catch (err) {
          onError(err)
        }
        resolveSettled()
      })
  }

  setTimer(begin, fallbackMs)

  return { windowReady: begin, settled }
}
