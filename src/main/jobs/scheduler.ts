// Scheduler hooks for recurring (nightly) and idle-time jobs — the
// mechanism CLAUDE.md's Phase 1 asks for, built now so Phase 5 has
// something real to wire backup and M25's nightly consolidation into
// instead of each hand-rolling its own timestamp file (memory-runtime.ts's
// ~20h-timestamp-file pattern, flagged in the M26 Phase 0 research as the
// thing this should replace). Nothing calls registerRecurring/registerIdle
// yet in Phase 1 — that's Phase 5's job.
import { app, powerMonitor } from 'electron'
import { join } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'
import { writeJsonAtomicSync } from '../atomic-write'

export interface RecurringSpec {
  name: string
  intervalMs: number
  run: () => void
}

export interface IdleSpec {
  name: string
  /** How long the system must have been idle (electron powerMonitor's
   *  getSystemIdleTime, in seconds) before this is allowed to fire. */
  idleThresholdSec: number
  /** Never fire again within this long of the last run, even if idle. */
  minGapMs: number
  run: () => void
}

/** Pure — is a recurring job due, given when it last ran (0/undefined =
 *  never)? Split out from the timer-driven wrapper below so this can be
 *  unit tested without fake timers, same pattern as this app's
 *  IdleStopWatcher (auto-stop.ts). */
export function isRecurringDue(
  intervalMs: number,
  lastRunAtMs: number | undefined,
  nowMs: number
): boolean {
  if (lastRunAtMs === undefined) return true
  return nowMs - lastRunAtMs >= intervalMs
}

/** Pure — is an idle job due right now? */
export function isIdleDue(
  spec: Pick<IdleSpec, 'idleThresholdSec' | 'minGapMs'>,
  lastRunAtMs: number | undefined,
  nowMs: number,
  currentIdleSec: number
): boolean {
  if (currentIdleSec < spec.idleThresholdSec) return false
  if (lastRunAtMs === undefined) return true
  return nowMs - lastRunAtMs >= spec.minGapMs
}

function statePath(): string {
  return join(app.getPath('userData'), 'jobs-scheduler.json')
}

function loadLastRuns(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function saveLastRuns(runs: Record<string, number>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeJsonAtomicSync(statePath(), runs)
}

/** How often the recurring/idle checks re-evaluate — independent of any one
 *  job's own interval, this just has to be frequent enough that no job
 *  drifts noticeably late. */
const CHECK_INTERVAL_MS = 60_000

export class Scheduler {
  private lastRuns: Record<string, number>
  private recurring: RecurringSpec[] = []
  private idle: IdleSpec[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private getIdleSec: () => number

  constructor(getIdleSec: () => number = defaultGetIdleSec) {
    this.lastRuns = loadLastRuns()
    this.getIdleSec = getIdleSec
  }

  registerRecurring(spec: RecurringSpec): void {
    this.recurring.push(spec)
    this.ensureTicking()
    this.checkOne(
      spec.name,
      () => isRecurringDue(spec.intervalMs, this.lastRuns[spec.name], Date.now()),
      spec.run
    )
  }

  registerIdle(spec: IdleSpec): void {
    this.idle.push(spec)
    this.ensureTicking()
  }

  private ensureTicking(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.checkAll(), CHECK_INTERVAL_MS)
    this.timer.unref?.() // never keep the app alive on its own
  }

  private checkAll(): void {
    for (const spec of this.recurring) {
      this.checkOne(
        spec.name,
        () => isRecurringDue(spec.intervalMs, this.lastRuns[spec.name], Date.now()),
        spec.run
      )
    }
    for (const spec of this.idle) {
      this.checkOne(
        spec.name,
        () => isIdleDue(spec, this.lastRuns[spec.name], Date.now(), this.getIdleSec()),
        spec.run
      )
    }
  }

  private checkOne(name: string, isDue: () => boolean, run: () => void): void {
    if (!isDue()) return
    this.lastRuns[name] = Date.now()
    saveLastRuns(this.lastRuns)
    run()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

function defaultGetIdleSec(): number {
  try {
    return powerMonitor.getSystemIdleTime()
  } catch {
    // Not ready yet (called before app.whenReady()) — never fatal, just
    // means nothing looks idle until it genuinely can be asked.
    return 0
  }
}
