// BUG-070 — a failed job-state write must be HANDLED, not left to become an
// unhandled rejection.
//
// This bug existed for weeks in plain sight, as the intermittent stray error
// everyone had filed under "the known flake." It was only ever visible as a
// non-zero exit code with zero failing tests — which the old
// `vitest run | tail` habit discarded in transit (taxonomy species 14). It
// took building a runner that preserves the exit code, and capturing the
// error text to a file, before anyone could see what it actually was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string

vi.mock('electron', () => ({
  app: { getPath: () => dir }
}))

// The real failure this stands in for is a write that genuinely cannot
// complete: disk full, a permissions problem, antivirus holding the temp
// file open. In the test suite the same rejection arrives via a teardown
// race (the temp directory removed while a throttled write is in flight),
// which is what made it look like noise rather than a finding.
const saveJobs = vi.fn(async () => {
  throw new Error('ENOENT: no such file or directory')
})

vi.mock('../store', () => ({
  loadJobs: () => [],
  saveJobs: (...args: unknown[]) => saveJobs(...(args as [])),
  interruptRunningJobs: (jobs: unknown) => jobs
}))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-persist-failure-'))
  saveJobs.mockClear()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('BUG-070: a failed job-state persist', () => {
  it('is caught and logged rather than becoming an unhandled rejection', async () => {
    vi.resetModules()
    const { JobManager } = await import('../JobManager')

    // Recorded, not merely spied: the assertion below needs to distinguish
    // "handled and logged" from "silently swallowed", and an empty call list
    // means the rejection went somewhere we don't control.
    const logged: unknown[][] = []
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => void logged.push(args))

    // A second, independent witness. Before the fix this is where the
    // rejection ended up — the process-wide net, which reports a real disk
    // failure as an anonymous crash-log line.
    const escaped: unknown[] = []
    const onUnhandled = (err: unknown): void => void escaped.push(err)
    process.on('unhandledRejection', onUnhandled)

    try {
      const manager = new JobManager([])
      manager.registerType({
        type: 'test:persist',
        lane: 'INTERACTIVE',
        titleFor: () => 'persist test',
        executor: { kind: 'inline-async', run: async () => ({}) }
      })
      manager.enqueue('test:persist', {})

      // PERSIST_THROTTLE_MS is 250 with leading:false, so the write fires on
      // the trailing edge. Waiting past it in real time (rather than with
      // fake timers) keeps the async rejection path identical to production.
      await new Promise((r) => setTimeout(r, 400))
      manager.dispose()
      // One more turn for the rejection to propagate wherever it is going.
      await new Promise((r) => setTimeout(r, 50))

      expect(saveJobs).toHaveBeenCalled() // the write really was attempted
      expect(escaped).toEqual([]) // nothing reached the process-wide net
      expect(
        logged.some((args) => typeof args[0] === 'string' && args[0].includes('[jobs]'))
      ).toBe(true) // and it was reported deliberately, with a scope
    } finally {
      process.off('unhandledRejection', onUnhandled)
      consoleSpy.mockRestore()
    }
  }, 10_000)
})
