// M29 A2.3 — every terminal job transition (silent jobs included — the
// Activity notifier skips those, which is why the hook lives in
// JobManager.transition, the one funnel) becomes a job.finished signal:
// jobType + outcome + short error code. The error MESSAGE never travels.
// Same harness as JobManager.test.ts; telemetry runs against the same
// temp dir with consent on.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
vi.mock('electron', () => ({
  app: { getPath: () => dir }
}))

function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

const PROSE = 'could not summarize the call with Dana about the forty thousand budget'

async function fresh(): Promise<{
  manager: InstanceType<typeof import('../JobManager').JobManager>
  telemetry: typeof import('../../telemetry/index')
}> {
  vi.resetModules()
  const telemetry = await import('../../telemetry/index')
  const setup = await import('../../telemetry/setup')
  const consent = await import('../../telemetry/consent')
  const { JobManager } = await import('../JobManager')
  setup.setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: join(dir, 'dumps') })
  consent.setConsent(dir, 'on')
  const manager = new JobManager()
  return { manager, telemetry }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'job-telemetry-'))
})
afterEach(async () => {
  const { resetTelemetry } = await import('../../telemetry/index')
  resetTelemetry()
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      break
    } catch (err) {
      if (attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
})

describe('job terminal transitions become job.finished signals', () => {
  it('success, failure (code only, never the message), and a SILENT job all count', async () => {
    const { manager, telemetry } = await fresh()
    manager.registerType<{ mode: string }, string>({
      type: 'test:tel',
      lane: 'INTERACTIVE',
      titleFor: () => 'Telemetry test',
      executor: {
        kind: 'inline-async',
        run: async (input) => {
          if (input.mode === 'fail') {
            throw Object.assign(new Error(PROSE), { code: 'rate-limit' })
          }
          return 'ok'
        }
      }
    })
    manager.registerType<{ mode: string }, string>({
      type: 'test:tel-silent',
      lane: 'INTERACTIVE',
      // silent lives on the TYPE definition — the Activity notifier skips
      // these entirely, which is exactly why the signal hook must not.
      silent: true,
      titleFor: () => 'Silent telemetry test',
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    manager.enqueue('test:tel', { mode: 'ok' })
    manager.enqueue('test:tel', { mode: 'fail' })
    manager.enqueue('test:tel-silent', { mode: 'ok' })
    await settle()
    await settle()

    const finished = telemetry.listQueued().filter((e) => e.name === 'job.finished')
    expect(finished.map((e) => [e.props.jobType, e.props.outcome]).sort()).toEqual([
      ['test:tel', 'failed'],
      ['test:tel', 'succeeded'],
      ['test:tel-silent', 'succeeded'] // the silent job counted
    ])
    const failed = finished.find((e) => e.props.outcome === 'failed')
    expect(failed?.props).toEqual({ jobType: 'test:tel', outcome: 'failed', code: 'rate-limit' })
    const all = JSON.stringify(telemetry.listQueued())
    expect(PROSE).toContain('Dana') // control
    expect(all).not.toContain('Dana')
    expect(all).not.toContain('forty thousand')
  })

  it('a progress tick on a running job emits nothing; cancellation counts once', async () => {
    const { manager, telemetry } = await fresh()
    let release!: () => void
    manager.registerType<Record<string, never>, void>({
      type: 'test:hold',
      lane: 'INTERACTIVE',
      // cancellable defaults FALSE (the brief's own lesson) — without this,
      // cancel() returns false and the assertion below would be about the
      // wrong scenario entirely.
      cancellable: true,
      titleFor: () => 'Hold',
      executor: {
        kind: 'inline-async',
        run: (_input, handle) =>
          new Promise<void>((resolve, reject) => {
            release = () => resolve()
            // Honour the abort signal — the manager only lands 'cancelled'
            // for a running job when the executor actually stops (BUG-060's
            // whole point); an executor that ignores it finishes 'succeeded'.
            handle.signal.addEventListener('abort', () => reject(new Error('aborted')))
            handle.reportProgress({ mode: 'determinate', itemsDone: 1, itemsTotal: 2 })
            handle.reportProgress({ mode: 'determinate', itemsDone: 2, itemsTotal: 2 })
          })
      }
    })
    const job = manager.enqueue('test:hold', {})
    await settle()
    expect(telemetry.listQueued().filter((e) => e.name === 'job.finished')).toHaveLength(0)
    manager.cancel(job.id)
    await settle()
    await settle()
    void release // completion already lost the race to the abort
    const finished = telemetry.listQueued().filter((e) => e.name === 'job.finished')
    expect(finished).toHaveLength(1)
    expect(finished[0].props.outcome).toBe('cancelled')
  })
})
