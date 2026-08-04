// Acceptance criterion 3: "a 5s main-thread stall does not affect
// transcription lag." §1.4's whole design rests on moving audio delivery off
// the renderer's main thread onto a real `Worker` — this test proves the
// underlying platform guarantee that makes that work at all: a genuinely
// separate OS thread keeps running its own scheduled work while a DIFFERENT
// thread is synchronously blocked.
//
// What this test is and is not. It uses Node's `worker_threads`, not a DOM
// `Worker` inside a real Chromium renderer — the actual production code is a
// DOM Worker (audio-pump.worker.ts) run by Electron's renderer process, and
// the actual "main thread" being protected against is that renderer's own JS
// thread, not Node's. Proving the identical claim against the real renderer
// needs a real multi-process Electron instance under Playwright, which this
// repo does not have (see docs/acceptance-criteria.md, criterion 3, for why
// that isn't added here unilaterally). What this test DOES honestly establish
// is the platform-level fact the whole design leans on: a scheduled callback
// on a separate OS thread is not paused by a synchronous block on another
// thread. That fact is what makes moving the drain off the main thread a real
// fix rather than a rearrangement of the same problem.
import { Worker } from 'worker_threads'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const WORKER_PATH = join(__dirname, 'thread-worker.js')
const STALL_MS = 5_000
const INTERVAL_MS = 20

function collectTicks(worker: Worker): Promise<number[]> {
  return new Promise((resolve, reject) => {
    worker.once('message', (msg: { type: string; ticks: number[] }) => {
      if (msg.type === 'ticks') resolve(msg.ticks)
      else reject(new Error(`unexpected message: ${JSON.stringify(msg)}`))
    })
    worker.once('error', reject)
  })
}

describe('a separate thread keeps running while this thread is blocked', () => {
  it(
    'ticks through a real 5s synchronous stall on the main thread',
    async () => {
      const worker = new Worker(WORKER_PATH)
      try {
        worker.postMessage({ type: 'start', intervalMs: INTERVAL_MS })
        // Let it get going before the stall, so the pre-stall cadence is part
        // of what gets checked for continuity across the blocked window.
        await new Promise((r) => setTimeout(r, 100))

        const stallStart = Date.now()
        // A REAL synchronous block of the thread running this test — no
        // setTimeout, no await, no yielding back to the event loop. This is
        // exactly the failure mode criterion 3 names: a long render/GC pause
        // that owns the thread for seconds at a time.
        while (Date.now() - stallStart < STALL_MS) {
          // deliberately busy — proving the OTHER thread is unaffected by this
        }
        const stallEnd = Date.now()

        worker.postMessage({ type: 'stop' })
        const ticks = await collectTicks(worker)

        // 1. The worker kept recording ticks DURING the window this thread
        // could not have serviced a single event, promise, or timer of its
        // own — proving its execution truly does not share this thread.
        const duringStall = ticks.filter((t) => t >= stallStart && t <= stallEnd)
        const expectedTicks = STALL_MS / INTERVAL_MS
        expect(duringStall.length).toBeGreaterThan(expectedTicks * 0.5)

        // 2. Its cadence stayed close to the requested interval throughout —
        // not just "eventually caught up" once this thread unblocked, but
        // genuinely running the whole time.
        const gaps: number[] = []
        for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i] - ticks[i - 1])
        const maxGap = Math.max(...gaps)
        // Generous tolerance for CI/container scheduling jitter — the property
        // under test is "no multi-second stall", not "perfectly metronomic".
        expect(maxGap).toBeLessThan(STALL_MS * 0.3)
      } finally {
        await worker.terminate()
      }
    },
    STALL_MS + 5_000
  )
})
