import { app, ipcMain } from 'electron'
import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

// M24 §8 — the feedback loop. "Store every cue with its thumbs up/down;
// per-user thresholds adapt over time (downweight cue types I keep
// rejecting)." Local-only, append-only JSONL — same shape/reasoning as
// ai/fallback-log.ts (a local history log with no existing telemetry
// pipeline to hook into), capped the same way for the same reason (a file
// that only ever grows needs a ceiling somewhere).

export interface FeedbackEvent {
  ts: string
  type: 'risk' | 'opportunity' | 'tactical'
  subtype: string
  helpful: boolean
}

const MAX_EVENTS = 2000

function feedbackFile(): string {
  return join(app.getPath('userData'), 'deal-intelligence-feedback.jsonl')
}

function isFeedbackEvent(v: unknown): v is FeedbackEvent {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.ts === 'string' &&
    (r.type === 'risk' || r.type === 'opportunity' || r.type === 'tactical') &&
    typeof r.subtype === 'string' &&
    typeof r.helpful === 'boolean'
  )
}

async function readEvents(): Promise<FeedbackEvent[]> {
  try {
    const raw = await readFile(feedbackFile(), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return null
        }
      })
      .filter(isFeedbackEvent)
  } catch {
    return [] // no file yet — a brand new install, not an error
  }
}

export async function recordFeedback(input: unknown): Promise<{ ok: boolean }> {
  const v = (input ?? {}) as { type?: unknown; subtype?: unknown; helpful?: unknown }
  if (
    (v.type !== 'risk' && v.type !== 'opportunity' && v.type !== 'tactical') ||
    typeof v.subtype !== 'string' ||
    !v.subtype ||
    typeof v.helpful !== 'boolean'
  ) {
    return { ok: false }
  }

  const event: FeedbackEvent = { ts: new Date().toISOString(), type: v.type, subtype: v.subtype.slice(0, 60), helpful: v.helpful }

  try {
    const dir = app.getPath('userData')
    await mkdir(dir, { recursive: true })
    const existing = await readEvents()
    // Trim from the front (oldest first) before appending, so the file never
    // grows past MAX_EVENTS — rewriting the whole file here rather than a
    // pure append is the cost of that cap, and this log is small (one line
    // per rated nudge, nudges are rare by design) so it's cheap in practice.
    if (existing.length >= MAX_EVENTS) {
      const trimmed = [...existing.slice(existing.length - MAX_EVENTS + 1), event]
      await appendFile(feedbackFile(), '', { flag: 'w' }) // truncate
      for (const e of trimmed) await appendFile(feedbackFile(), `${JSON.stringify(e)}\n`)
    } else {
      await appendFile(feedbackFile(), `${JSON.stringify(event)}\n`)
    }
    return { ok: true }
  } catch {
    // Feedback is a nice-to-have signal, never something worth surfacing an
    // error for — a rep clicking thumbs-down should never see a failure toast.
    return { ok: false }
  }
}

/** Per-(type,subtype) rejection rate, only for pairs with enough ratings to
 *  mean anything — a single thumbs-down on a brand-new subtype shouldn't
 *  immediately raise its bar. Read once per call at start (see
 *  useDealIntelligence.ts), not re-read mid-call. */
export interface FeedbackSummaryEntry {
  type: 'risk' | 'opportunity' | 'tactical'
  subtype: string
  totalRatings: number
  rejectionRate: number
}

const MIN_RATINGS_TO_ADAPT = 3

export async function getFeedbackSummary(): Promise<FeedbackSummaryEntry[]> {
  const events = await readEvents()
  const bySubtype = new Map<string, { type: FeedbackEvent['type']; subtype: string; total: number; rejected: number }>()
  for (const e of events) {
    const key = `${e.type}:${e.subtype}`
    const entry = bySubtype.get(key) ?? { type: e.type, subtype: e.subtype, total: 0, rejected: 0 }
    entry.total += 1
    if (!e.helpful) entry.rejected += 1
    bySubtype.set(key, entry)
  }
  return [...bySubtype.values()]
    .filter((e) => e.total >= MIN_RATINGS_TO_ADAPT)
    .map((e) => ({
      type: e.type,
      subtype: e.subtype,
      totalRatings: e.total,
      rejectionRate: e.rejected / e.total
    }))
}

let registered = false

export function registerDealFeedback(): void {
  if (registered) return
  registered = true
  ipcMain.handle('dealIntelligence:recordFeedback', (_e, input: unknown) => recordFeedback(input))
  ipcMain.handle('dealIntelligence:getFeedbackSummary', () => getFeedbackSummary())
}
