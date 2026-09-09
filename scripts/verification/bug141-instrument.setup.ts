/**
 * BUG-141 instrument — catch the stall in the act, without changing any test.
 *
 * Loaded as a vitest `setupFiles` entry by `vitest.bug141.config.ts`. Inert
 * unless BUG141_LOG names a directory.
 *
 * What it records, per test, into one JSONL file per worker process:
 *   dur      wall-clock ms for the test body
 *   cpuMs    CPU-ms (user+system) THIS WORKER burned during that wall time
 *   elMax    worst event-loop delay observed during the test, ms
 * Those three separate the three candidate regimes a bare timeout cannot:
 *   - cpuMs ~ dur              -> the worker was computing (or thrashing)
 *   - cpuMs ~ 0, elMax high    -> the worker's loop was BLOCKED (sync call, GC)
 *   - cpuMs ~ 0, elMax low     -> the worker was WAITING on something external
 * and on a stall the watchdog additionally names WHAT it was waiting on:
 * `process._getActiveRequests()` shows an in-flight filesystem op as an
 * FSReq*. That visibility was proved with a positive AND a negative control
 * before this file was trusted (canary-active-requests.mjs, 2026-09-09).
 *
 * KNOWN BLIND SPOT, measured not assumed: a test that blocks the event loop
 * synchronously produces NO stall record, because the watchdog timer cannot
 * fire while the loop is blocked and `afterEach` clears it first. The per-test
 * record still catches that case (cpuMs ~ dur), which is why both exist.
 */
import { afterAll, afterEach, beforeEach } from 'vitest'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const LOG_DIR = process.env.BUG141_LOG
if (LOG_DIR) {
  mkdirSync(LOG_DIR, { recursive: true })
  const OUT = join(LOG_DIR, `w-${process.pid}.jsonl`)
  const RUN = process.env.BUG141_RUN ?? '0'
  const WATCHDOGS = [3000, 8000, 15000]
  const NL = String.fromCharCode(10)

  const names = (xs: unknown[]): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const x of xs) {
      const n = (x as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'
      out[n] = (out[n] ?? 0) + 1
    }
    return out
  }
  const activeReqs = (): Record<string, number> => {
    const f = (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests
    return typeof f === 'function' ? names(f.call(process)) : { UNAVAILABLE: 1 }
  }
  const activeHandles = (): Record<string, number> => {
    const f = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles
    return typeof f === 'function' ? names(f.call(process)) : { UNAVAILABLE: 1 }
  }

  // MODULE-RESOLUTION VIEW. vitest's worker object carries the set of module
  // ids it is CURRENTLY resolving. If a stalled test is stuck fetching or
  // transforming a module — the pipeline is one shared vite server in the main
  // process, serving every worker at once — this names the module. An empty
  // set during a stall rules module loading out just as firmly.
  const resolving = (): string[] => {
    const w = (globalThis as Record<string, unknown>).__vitest_worker__ as
      Record<string, unknown> | undefined
    const r = w?.resolvingModules as Iterable<unknown> | undefined
    if (!r || typeof (r as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function')
      return []
    return [...r]
      .map((x) => String(Array.isArray(x) ? x[0] : x).replace(/^.*(src|node_modules)./, '$1/'))
      .slice(0, 8)
  }
  const evaluatedCount = (): number => {
    const w = (globalThis as Record<string, unknown>).__vitest_worker__ as
      Record<string, unknown> | undefined
    // EvaluatedModules is not a Map; the id index lives one level in.
    const e = w?.evaluatedModules as { idToModuleMap?: { size?: number } } | undefined
    return e?.idToModuleMap?.size ?? -1
  }

  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()

  let buf: string[] = []
  // FLUSH POINT. The first version buffered and relied on process.on('exit');
  // the self-test proved that loses records — vitest's forks pool does not
  // exit workers cleanly enough. `afterAll` in a setup file runs once per TEST
  // FILE (~409 flushes per suite run), so nothing is lost if a worker is
  // killed mid-run, at a cost small enough not to perturb what is measured.
  const flush = (): void => {
    if (!buf.length) return
    const out = buf.join(NL) + NL
    buf = []
    appendFileSync(OUT, out)
  }
  const write = (rec: unknown, now = false): void => {
    buf.push(JSON.stringify(rec))
    if (now || buf.length >= 100) flush()
  }
  afterAll(() => flush())
  process.on('exit', () => {
    try {
      flush()
    } catch {
      /* exiting anyway */
    }
  })

  // PHASE HOOK. A test file can call this to split its own wall time into
  // named phases, so a stall can be attributed to a PHASE rather than to the
  // test as a whole. Optional-call syntax at every call site keeps the tests
  // runnable under the normal config, where this global does not exist.
  let phases: Record<string, number> = {}
  ;(globalThis as Record<string, unknown>).__bug141phase = (label: string, ms: number): void => {
    phases[label] = Math.round((phases[label] ?? 0) + ms)
  }

  const seen = new Map<string, number>()
  let t0 = 0
  let cpu0 = process.cpuUsage()
  let timers: NodeJS.Timeout[] = []

  beforeEach((ctx) => {
    const file = ctx.task.file?.name ?? '?'
    const idx = seen.get(file) ?? 0
    seen.set(file, idx + 1)
    h.reset()
    phases = {}
    t0 = performance.now()
    cpu0 = process.cpuUsage()
    timers = WATCHDOGS.map((ms) => {
      const t = setTimeout(() => {
        const cpu = process.cpuUsage(cpu0)
        write(
          {
            kind: 'stall',
            run: RUN,
            pid: process.pid,
            at: new Date().toISOString(),
            file,
            idx,
            name: ctx.task.name,
            waited: ms,
            elapsed: Math.round(performance.now() - t0),
            cpuMs: Math.round((cpu.user + cpu.system) / 1000),
            elMax: Math.round(h.max / 1e6),
            elMean: Math.round(h.mean / 1e6),
            phases: { ...phases },
            resolving: resolving(),
            evaluated: evaluatedCount(),
            reqs: activeReqs(),
            handles: activeHandles(),
            rss: Math.round(process.memoryUsage().rss / 1e6)
          },
          true
        )
      }, ms)
      t.unref()
      return t
    })
  })

  afterEach((ctx) => {
    for (const t of timers) clearTimeout(t)
    timers = []
    const dur = performance.now() - t0
    const cpu = process.cpuUsage(cpu0)
    const file = ctx.task.file?.name ?? '?'
    const idx = (seen.get(file) ?? 1) - 1
    write({
      kind: 'test',
      run: RUN,
      pid: process.pid,
      at: Date.now(),
      file,
      idx,
      name: ctx.task.name,
      dur: Math.round(dur),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      elMax: Math.round(h.max / 1e6),
      phases: { ...phases },
      state: ctx.task.result?.state ?? '?'
    })
  })
}
