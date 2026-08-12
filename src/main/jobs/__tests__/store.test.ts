import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../types'

let dir: string

vi.mock('electron', () => ({
  app: { getPath: () => dir }
}))

async function freshModule(): Promise<typeof import('../store')> {
  vi.resetModules()
  return import('../store')
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'dev:fakeBatch',
    title: 'Test job',
    state: 'queued',
    progress: { mode: 'indeterminate' },
    lane: 'BATCH',
    priority: 0,
    createdAt: 1000,
    cancellable: true,
    input: { n: 1 },
    ...overrides
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-jobs-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadJobs / saveJobs', () => {
  it('returns an empty list when no state file exists yet', async () => {
    const { loadJobs } = await freshModule()
    expect(loadJobs()).toEqual([])
  })

  it('round-trips a saved job list exactly', async () => {
    const { loadJobs, saveJobs } = await freshModule()
    const jobs = [makeJob({ id: 'a', state: 'succeeded' }), makeJob({ id: 'b', state: 'failed' })]
    await saveJobs(jobs)
    expect(loadJobs()).toEqual(jobs)
  })

  it('a job that was still "running" when last saved loads as "interrupted"', async () => {
    const { loadJobs, saveJobs } = await freshModule()
    await saveJobs([makeJob({ id: 'a', state: 'running', startedAt: 500, checkpoint: 7 })])
    const loaded = loadJobs()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].state).toBe('interrupted')
    expect(loaded[0].checkpoint).toBe(7) // the checkpoint itself must survive the reclassification
  })

  it('never crashes on a corrupt state file — starts clean instead', async () => {
    const { loadJobs } = await freshModule()
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'jobs-state.json'), '{not valid json', 'utf8')
    expect(loadJobs()).toEqual([])
  })

  it('never crashes when the state file holds something that is not an array', async () => {
    const { loadJobs } = await freshModule()
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'jobs-state.json'), '{"oops":"not an array"}', 'utf8')
    expect(loadJobs()).toEqual([])
  })
})
