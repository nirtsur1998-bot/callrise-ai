// Dev-only job types with controllable duration, progress pattern, and
// failure mode — exactly what CLAUDE.md's testing section asks Phase 1 to
// ship, so the queue/lanes/cancel/resume machinery can be exercised
// deterministically from the Job Inspector without needing any real
// feature (or a live call, or an AI key) wired up yet. Never registered in
// a packaged build — see the `is.dev` guard at the one call site in
// src/main/index.ts.
import type { JobManager } from './JobManager'
import type { JobProgress } from './types'

export interface FakeBatchInput {
  title: string
  itemsTotal: number
  msPerItem: number
  /** 1-based item number to fail at, if any. */
  failAtItem?: number
}

export interface FakeStagedInput {
  title: string
  stages: string[]
  msPerStage: number
  /** Index into `stages` to fail at, if any. */
  failAtStage?: number
}

export interface FakeCpuInput {
  title: string
  itemsTotal: number
  /** Total wall-clock time to burn across all items, spread evenly. */
  msBudget: number
  failAtItem?: number
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

// Plain JS, not TS: eval'd directly inside a worker_threads Worker (see
// JobTypeDefinition's 'worker' executor kind in types.ts) rather than
// transpiled, so no type annotations here.
const FAKE_CPU_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { input, lastCheckpoint } = workerData
const startAt = typeof lastCheckpoint === 'number' ? lastCheckpoint : 0
;(async () => {
  try {
    for (let i = startAt; i < input.itemsTotal; i++) {
      if (input.failAtItem === i + 1) {
        parentPort.postMessage({ type: 'error', message: 'Fake worker failure at item ' + (i + 1) })
        return
      }
      // Deliberately burns real CPU on this thread, not main's — the whole
      // point of this fake job is proving that never freezes the app.
      const busyUntil = Date.now() + Math.max(1, Math.floor(input.msBudget / input.itemsTotal))
      while (Date.now() < busyUntil) {
        /* burn */
      }
      parentPort.postMessage({ type: 'checkpoint', data: i + 1 })
      parentPort.postMessage({
        type: 'progress',
        progress: { mode: 'determinate', itemsDone: i + 1, itemsTotal: input.itemsTotal }
      })
    }
    parentPort.postMessage({ type: 'result', result: 'fake-cpu-result-' + input.itemsTotal })
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String((err && err.message) || err) })
  }
})()
`

export function registerFakeJobTypes(manager: JobManager): void {
  manager.registerType<FakeBatchInput, string>({
    type: 'dev:fakeBatch',
    lane: 'BATCH',
    titleFor: (input) => input.title,
    // BUG-060 — earned: the loop below genuinely checks handle.signal and
    // uses an abortable sleep. These dev fixtures are the reference for what
    // "wired for cancellation" actually looks like.
    cancellable: true,
    executor: {
      kind: 'inline-async',
      run: async (input, handle) => {
        const startAt = typeof handle.lastCheckpoint === 'number' ? handle.lastCheckpoint : 0
        for (let i = startAt; i < input.itemsTotal; i++) {
          if (handle.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          if (input.failAtItem === i + 1) throw new Error(`Fake failure at item ${i + 1}`)
          await sleep(input.msPerItem, handle.signal)
          handle.checkpoint(i + 1)
          const progress: JobProgress = {
            mode: 'determinate',
            itemsDone: i + 1,
            itemsTotal: input.itemsTotal
          }
          handle.reportProgress(progress)
        }
        return `fake-batch-result-${input.itemsTotal}`
      }
    }
  })

  manager.registerType<FakeStagedInput, string>({
    type: 'dev:fakeStaged',
    lane: 'INTERACTIVE',
    titleFor: (input) => input.title,
    // BUG-060 — earned, same as dev:fakeBatch above.
    cancellable: true,
    executor: {
      kind: 'inline-async',
      run: async (input, handle) => {
        for (let i = 0; i < input.stages.length; i++) {
          if (handle.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          if (input.failAtStage === i) throw new Error(`Fake failure at stage "${input.stages[i]}"`)
          handle.reportProgress({ mode: 'stages', stageLabel: input.stages[i] })
          await sleep(input.msPerStage, handle.signal)
        }
        return 'fake-staged-result'
      }
    }
  })

  manager.registerType<FakeCpuInput, string>({
    type: 'dev:fakeCpu',
    lane: 'MAINTENANCE',
    titleFor: (input) => input.title,
    // BUG-060 — earned, and the ONLY kind that gets it for free: a 'worker'
    // executor is cancelled by worker.terminate(), which is preemptive rather
    // than cooperative. No production job type uses this kind today.
    cancellable: true,
    executor: { kind: 'worker', workerSource: FAKE_CPU_WORKER_SOURCE }
  })
}
