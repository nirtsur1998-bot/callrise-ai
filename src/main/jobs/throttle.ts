/**
 * Throttle: at most one call to `fn` per `intervalMs`, always with the
 * LATEST args from whatever calls arrived in between (never a stale middle
 * one), so a hot loop can never flood a downstream consumer (CLAUDE.md:
 * "throttle updates ~4/sec max so a hot loop can't flood IPC") while still
 * delivering current state promptly.
 *
 * `leading` (default true) controls whether the first call after a quiet
 * period fires synchronously or waits out the first interval like every
 * later call — matters for `cancel()`: with leading calls enabled, a call
 * can already be mid-flight (an already-STARTED async `fn`) by the time
 * `cancel()` runs, which can only ever clear a still-PENDING timer, not
 * un-start something already running. Set `leading: false` wherever
 * `cancel()` needs to be a real guarantee that no call is left able to fire
 * afterward (e.g. JobManager's own persistence, cancelled on dispose()) —
 * true everywhere latency to the first update matters more (e.g. the IPC
 * progress broadcast in jobs/ipc.ts, where the whole point is the
 * Activity Center reflecting a job's very first tick promptly).
 */
export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
  opts: { leading?: boolean } = {}
): { call: (...args: Args) => void; cancel: () => void } {
  const leading = opts.leading ?? true
  let lastRun = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: Args | null = null

  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    pendingArgs = null
  }

  const call = (...args: Args): void => {
    const now = Date.now()
    const elapsed = now - lastRun
    if (leading && elapsed >= intervalMs) {
      lastRun = now
      fn(...args)
      return
    }
    pendingArgs = args
    if (timer) return
    const delay = leading ? intervalMs - elapsed : intervalMs
    timer = setTimeout(
      () => {
        timer = null
        lastRun = Date.now()
        const trailing = pendingArgs
        pendingArgs = null
        if (trailing) fn(...trailing)
      },
      Math.max(0, delay)
    )
  }

  return { call, cancel }
}
