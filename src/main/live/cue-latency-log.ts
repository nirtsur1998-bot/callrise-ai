// BUG-225 — the cue latency instrument had nowhere to put its answer.
//
// `CueLatencyTracker` measures turn-end → cue-on-screen for every cue and
// buckets it by how the cue was produced. It is a good instrument: nearest-rank
// percentiles so every published number is a latency that genuinely happened,
// a 200-sample window so a long call's early minutes stop dominating. Its
// report went into React state and **nothing ever read it** — never rendered,
// never logged, never persisted — and `latencyRef.current.reset()` then
// destroyed the samples at the call boundary, which is precisely the moment
// they became worth keeping. Taxonomy species 14: the correct tool whose
// signal you discard in transit.
//
// WHY THIS EXISTS RATHER THAN A UI. The founder's question is comparative:
// *"whether adding client facts to the live cue prompt costs anything
// measurable"* (BUG-222). That cannot be answered by a number on screen during
// one call — it needs a HISTORY that outlives the call, so a before and an
// after can be put side by side. A destination, not a display.
//
// WHY THE RAW SAMPLES ARE KEPT AND NOT JUST THE PER-CALL p50/p95.
// A percentile of percentiles is not a percentile. Averaging ten calls' p95
// values answers no question anyone asked: a 3-cue call and a 200-cue call
// would count equally, and the tail — the thing a p95 exists to expose —
// disappears into the mean. So each line carries the samples that produced its
// summary, and any across-call figure is computed from the pooled samples.
// The summary is there to be readable by eye; the samples are there to be
// correct.
//
// LOCAL-ONLY AND METADATA-ONLY, the same posture as ai-fallback-events.jsonl
// which this follows: integers in milliseconds, a tier name and a call id.
// No transcript, no cue text, no buyer speech. Nothing here is uploaded by the
// backup — it is not a record store.
import { app, ipcMain } from 'electron'
import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type LatencySource = 'deterministic' | 'model'

export interface CueLatencyEntry {
  ts: string
  /** Null for a call that was never saved (stopped before a transcript). */
  callId: string | null
  /** Per tier: the samples that produced this call's numbers, in ms. */
  samples: Record<LatencySource, number[]>
}

/** 200 calls. At ≤200 samples per tier per call this stays a few MB at worst,
 *  and it is more history than any before/after comparison needs. */
const MAX_ENTRIES = 200

/** A call with no cues at all has nothing to say about cue latency, and a line
 *  saying so would dilute every aggregate that counts lines. */
function hasSamples(e: CueLatencyEntry): boolean {
  return e.samples.deterministic.length > 0 || e.samples.model.length > 0
}

export function cueLatencyLogPath(): string {
  return join(app.getPath('userData'), 'cue-latency.jsonl')
}

/** Sanitise at the boundary: this arrives from the renderer over IPC. */
export function sanitiseEntry(value: unknown): CueLatencyEntry | null {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const nums = (x: unknown): number[] =>
    Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0).slice(0, 500) : []
  const s = (v.samples && typeof v.samples === 'object' ? v.samples : {}) as Record<string, unknown>
  const entry: CueLatencyEntry = {
    ts: typeof v.ts === 'string' ? v.ts : new Date().toISOString(),
    callId: typeof v.callId === 'string' && v.callId.length <= 64 ? v.callId : null,
    samples: { deterministic: nums(s.deterministic), model: nums(s.model) }
  }
  return hasSamples(entry) ? entry : null
}

/**
 * ONE LINE PER CALL, even though a call can flush more than once.
 *
 * The renderer flushes at every moment the measurements stop being
 * replaceable, and a single call reaches several of them: a capture blip drops
 * `active` and brings it back, the screen can be torn down and remounted. Each
 * flush carries only the samples taken since the last one — the tracker is
 * cleared as it hands them over — so plain appending would be arithmetically
 * fine but would count one call as three, and `calls` is the denominator a
 * reader uses to decide whether a percentile is worth believing.
 *
 * So a flush whose callId matches the last line MERGES into it. Keyed on the
 * last line only, not a search: calls are sequential, and a search would let a
 * recycled id from days ago absorb today's samples.
 */
export async function appendCueLatency(entry: CueLatencyEntry): Promise<void> {
  try {
    const path = cueLatencyLogPath()
    let lines: string[] = []
    try {
      lines = (await fs.readFile(path, 'utf8')).split('\n').filter(Boolean)
    } catch {
      /* first write on this device */
    }
    const merged = entry.callId === null ? null : mergeIntoLast(lines, entry)
    if (merged) await fs.writeFile(path, `${merged.join('\n')}\n`, 'utf8')
    else await fs.appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8')
    await pruneIfNeeded()
  } catch {
    // A logging failure must never break the call it is describing.
  }
}

/** Returns the rewritten lines if the last one is the same call, else null. */
function mergeIntoLast(lines: string[], entry: CueLatencyEntry): string[] | null {
  const last = lines[lines.length - 1]
  if (last === undefined) return null
  let prev: CueLatencyEntry | null = null
  try {
    prev = sanitiseEntry(JSON.parse(last))
  } catch {
    return null
  }
  if (!prev || prev.callId !== entry.callId) return null
  const combined: CueLatencyEntry = {
    // The FIRST flush's timestamp: the line describes a call, and a call
    // happened when it started, not when its last blip ended.
    ts: prev.ts,
    callId: prev.callId,
    samples: {
      deterministic: [...prev.samples.deterministic, ...entry.samples.deterministic].slice(-500),
      model: [...prev.samples.model, ...entry.samples.model].slice(-500)
    }
  }
  return [...lines.slice(0, -1), JSON.stringify(combined)]
}

async function pruneIfNeeded(): Promise<void> {
  try {
    const raw = await fs.readFile(cueLatencyLogPath(), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    if (lines.length <= MAX_ENTRIES) return
    await fs.writeFile(cueLatencyLogPath(), `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, 'utf8')
  } catch {
    /* best effort — a failed prune just means the file grows a little more */
  }
}

export async function readCueLatencyEntries(limit = MAX_ENTRIES): Promise<CueLatencyEntry[]> {
  try {
    const raw = await fs.readFile(cueLatencyLogPath(), 'utf8')
    const out: CueLatencyEntry[] = []
    for (const line of raw.split('\n').filter(Boolean).slice(-limit)) {
      try {
        const e = sanitiseEntry(JSON.parse(line))
        if (e) out.push(e)
      } catch {
        /* one bad line must not hide the rest */
      }
    }
    return out
  } catch {
    return []
  }
}

/** Nearest-rank, matching cue-latency.ts: every reported number is a latency
 *  that genuinely occurred. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export interface PooledStats {
  calls: number
  count: number
  p50: number | null
  p95: number | null
  max: number | null
}

/**
 * Across-call figures, computed from POOLED SAMPLES rather than by combining
 * per-call percentiles — see the header. A call contributes in proportion to
 * how many cues it actually produced, which is the only weighting that makes
 * the tail mean anything.
 */
export function poolStats(entries: CueLatencyEntry[], tier: LatencySource): PooledStats {
  const all: number[] = []
  let calls = 0
  for (const e of entries) {
    const s = e.samples[tier]
    if (s.length > 0) calls++
    for (const n of s) all.push(n)
  }
  all.sort((a, b) => a - b)
  return {
    calls,
    count: all.length,
    p50: percentile(all, 50),
    p95: percentile(all, 95),
    max: all.length ? all[all.length - 1] : null
  }
}

export interface CueLatencySummary {
  calls: number
  deterministic: PooledStats
  model: PooledStats
  meaning: string
}

/**
 * The support-bundle view: pooled percentiles, NO call ids, NO raw samples.
 *
 * The raw log stays on the device on purpose. It is the right artifact for
 * BUG-222's before/after — you need the samples to pool them — and the wrong
 * one to email to support: up to 200 calls x 500 samples x 2 tiers is a large
 * file that no human reads, and every line carries a call id. What a support
 * reader actually needs from "the cues feel slow" is one row per tier, which is
 * this. Synchronous and dir-taking because the bundle builder is given its
 * source directory rather than asking Electron for one — that is what lets its
 * tests run against a fixture.
 */
export function summariseCueLatency(userDataDir: string): CueLatencySummary {
  let entries: CueLatencyEntry[] = []
  try {
    for (const line of readFileSync(join(userDataDir, 'cue-latency.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = sanitiseEntry(JSON.parse(line))
        if (e) entries.push(e)
      } catch {
        /* one torn line must not hide the rest */
      }
    }
  } catch {
    entries = []
  }
  return {
    calls: entries.length,
    deterministic: poolStats(entries, 'deterministic'),
    model: poolStats(entries, 'model'),
    meaning:
      entries.length === 0
        ? 'No calls with cues have ended on this device since the log was added. This is an absence of data, not a report that latency is fine.'
        : 'Milliseconds from turn-end to cue-on-screen, pooled across calls (a percentile of percentiles is not a percentile). Nearest-rank: every number is a latency that genuinely occurred.'
  }
}

export function registerCueLatencyLog(): void {
  // `send`, not `invoke`: the renderer is closing a call and must not wait on a
  // disk write to do it, and there is nothing useful to return.
  ipcMain.on('live:cueLatency', (_e, payload: unknown) => {
    const entry = sanitiseEntry(payload)
    if (entry) void appendCueLatency(entry)
  })
}
