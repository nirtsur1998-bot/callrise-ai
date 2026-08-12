// Persistence for the job queue — one JSON file, same durable-write
// primitive every other main-process store in this app already uses
// (atomic-write.ts), same "small file, safe default on any read failure"
// shape as app-settings.ts.
import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'
import { writeJsonAtomic } from '../atomic-write'
import type { Job } from './types'

function statePath(): string {
  return join(app.getPath('userData'), 'jobs-state.json')
}

/**
 * A job that was still `running` when this was last written did not get the
 * chance to reach a terminal state on its own — the process that owned it
 * is gone (a crash, a force-quit, an update install). It is not `failed`
 * (nothing about its own work went wrong) and not silently resumable
 * either — surfaced honestly as `interrupted` so the Activity Center can
 * offer Resume/Retry/Dismiss, per CLAUDE.md's persistence requirement.
 */
export function loadJobs(): Job[] {
  let raw: string
  try {
    raw = readFileSync(statePath(), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [] // a torn/corrupt file must never crash startup — start clean
  }
  if (!Array.isArray(parsed)) return []
  return (parsed as Job[]).map((j) => (j.state === 'running' ? { ...j, state: 'interrupted' } : j))
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  mkdirSync(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(statePath(), jobs)
}
