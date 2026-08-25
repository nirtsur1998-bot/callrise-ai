// M29 A1.1 — the local telemetry queue: `userData/telemetry-queue.jsonl`.
//
// One validated TelemetryEvent per line, append-only, bounded (oldest dropped
// first), and READABLE BY THE USER: the "View what's been queued / sent"
// screen (A1.3/A1.5) renders exactly these lines. Nothing is written here
// unless consent is on — that gate lives in the front door (index.ts); this
// module just owns the file.
//
// Synchronous fs on purpose: events are rare (errors, counters), the writes
// are tiny, and the log writer next door is sync too. An event recorded in a
// crash handler must land before the process dies; an async write would not.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isTelemetryEvent, type TelemetryEvent } from './events'

export const QUEUE_FILENAME = 'telemetry-queue.jsonl'

export interface QueueLimits {
  maxEvents: number
  maxBytes: number
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  maxEvents: 500,
  maxBytes: 1024 * 1024 // 1 MB
}

export class TelemetryQueue {
  readonly path: string
  private readonly limits: QueueLimits

  constructor(userDataDir: string, limits: Partial<QueueLimits> = {}) {
    this.path = join(userDataDir, QUEUE_FILENAME)
    this.limits = { ...DEFAULT_QUEUE_LIMITS, ...limits }
  }

  /** Append one event. Never throws; returns false if it could not be written. */
  append(event: TelemetryEvent): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(event)}\n`, { flag: 'a', encoding: 'utf8' })
      this.pruneIfNeeded()
      return true
    } catch {
      return false
    }
  }

  /** Every queued event, oldest first. Malformed lines are skipped, not thrown on. */
  list(): TelemetryEvent[] {
    try {
      if (!existsSync(this.path)) return []
      const out: TelemetryEvent[] = []
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (isTelemetryEvent(parsed)) out.push(parsed)
        } catch {
          /* skip a torn/corrupt line */
        }
      }
      return out
    } catch {
      return []
    }
  }

  size(): number {
    return this.list().length
  }

  /** Remove the events with these ids (after a successful send). Never throws. */
  ack(ids: ReadonlySet<string>): void {
    try {
      const keep = this.list().filter((e) => !ids.has(e.id))
      this.rewrite(keep)
    } catch {
      /* best-effort */
    }
  }

  /** Delete everything — the user's "delete my telemetry queue" button, and opt-out. */
  clear(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path)
    } catch {
      /* best-effort */
    }
  }

  private pruneIfNeeded(): void {
    try {
      const bytes = statSync(this.path).size
      const events = this.list()
      if (events.length <= this.limits.maxEvents && bytes <= this.limits.maxBytes) return
      let kept = events.slice(-this.limits.maxEvents)
      // Drop oldest until under the byte cap too.
      let serialized = kept.map((e) => JSON.stringify(e))
      while (serialized.join('\n').length + 1 > this.limits.maxBytes && kept.length > 0) {
        kept = kept.slice(1)
        serialized = serialized.slice(1)
      }
      this.rewrite(kept)
    } catch {
      /* a failed prune just means the file is a bit over for now */
    }
  }

  private rewrite(events: TelemetryEvent[]): void {
    if (events.length === 0) {
      this.clear()
      return
    }
    writeFileSync(this.path, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
  }
}
