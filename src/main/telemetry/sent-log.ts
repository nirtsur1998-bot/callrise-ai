// M29 A1.5 — the sent log: `userData/telemetry-sent.jsonl`.
//
// "Everything sent is inspectable: a 'View what's been sent' screen showing
// the actual payloads, not a description of them." This file holds, per
// batch, the EXACT request body that left the machine — byte-identical to
// what the transport posted — plus when and with what HTTP status. Settings
// renders it. Bounded like the queue; the user can delete it.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IngestRow } from './transport'

export const SENT_LOG_FILENAME = 'telemetry-sent.jsonl'

export interface SentBatch {
  sentAt: string
  status: number | null
  /** Number of events in the batch. */
  count: number
  /** The exact JSON body that was POSTed. */
  body: string
}

export const SENT_LOG_LIMITS = { maxBatches: 200, maxBytes: 1024 * 1024 }

export function sentLogPath(userDataDir: string): string {
  return join(userDataDir, SENT_LOG_FILENAME)
}

export function appendSent(userDataDir: string, batch: SentBatch): void {
  try {
    const path = sentLogPath(userDataDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(batch)}\n`, { flag: 'a', encoding: 'utf8' })
    pruneIfNeeded(path)
  } catch {
    /* the send already happened; failing to record it must not throw */
  }
}

export function listSent(userDataDir: string): SentBatch[] {
  try {
    const path = sentLogPath(userDataDir)
    if (!existsSync(path)) return []
    const out: SentBatch[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const b = JSON.parse(line) as Partial<SentBatch>
        if (
          typeof b.sentAt === 'string' &&
          typeof b.body === 'string' &&
          typeof b.count === 'number'
        ) {
          out.push({
            sentAt: b.sentAt,
            status: typeof b.status === 'number' ? b.status : null,
            count: b.count,
            body: b.body
          })
        }
      } catch {
        /* skip a torn line */
      }
    }
    return out
  } catch {
    return []
  }
}

/** The rows inside every sent batch, newest batch first — what the screen shows. */
export function listSentRows(userDataDir: string, limit = 200): IngestRow[] {
  const rows: IngestRow[] = []
  for (const batch of listSent(userDataDir).reverse()) {
    try {
      const parsed: unknown = JSON.parse(batch.body)
      // The RPC body is `{ rows: [...] }`, not a bare array (transport.ts
      // targets telemetry_ingest_batch, not a direct table insert) — a
      // batch that predates that change would still be a bare array, so
      // both shapes are read rather than assuming only the current one.
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
          ? (parsed as { rows: unknown[] }).rows
          : null
      if (list) {
        for (const r of list as IngestRow[]) {
          rows.push(r)
          if (rows.length >= limit) return rows
        }
      }
    } catch {
      /* a batch we can't parse is still in the raw log; skip for display */
    }
  }
  return rows
}

export function clearSent(userDataDir: string): void {
  try {
    const path = sentLogPath(userDataDir)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* best-effort */
  }
}

function pruneIfNeeded(path: string): void {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    const bytes = statSync(path).size
    if (lines.length <= SENT_LOG_LIMITS.maxBatches && bytes <= SENT_LOG_LIMITS.maxBytes) return
    let kept = lines.slice(-SENT_LOG_LIMITS.maxBatches)
    while (kept.join('\n').length + 1 > SENT_LOG_LIMITS.maxBytes && kept.length > 1)
      kept = kept.slice(1)
    writeFileSync(path, `${kept.join('\n')}\n`, 'utf8')
  } catch {
    /* best-effort */
  }
}
