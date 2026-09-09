// BUG-238 — a SKIPPED quote sweep must run again; only a COMPLETED one latches.
//
// The bug: the one-shot latch tested the record's PRESENCE.
//
//     if (quoteSweepRecord(handle)) return          // before
//     if (quoteSweepIsComplete(handle)) return      // after
//
// The sweep writes a `status: 'skipped'` record on two paths, and BOTH are
// conditions of a single launch rather than of the profile:
//
//   1. 'connection replaced during startup' — the db handle was swapped while
//      the calls directory was being read.
//   2. 'calls directory read as empty while memories exist — refusing to
//      sweep' — the safety refusal, which exists so a failed directory read
//      cannot orphan every quote in the store and redact the lot.
//
// The second is the dangerous one. It fires in exactly the conditions BUG-236
// was written about: a Windows first launch after an upgrade, with files
// briefly locked by antivirus. So the SAFETY REFUSAL became a permanent
// opt-out of the SAFETY FEATURE — BUG-215's promise, that deleting a call
// takes its words out of the Sales Brain, silently never ran on that machine,
// and nothing anywhere said so. Recovery required hand-deleting a memory_meta
// row that no UI exposes.
//
// THE FINDING WAS THE ASYMMETRY, not the line. Twenty lines below, the sibling
// one-shot job in the same file always tested status:
//
//     if (temporalBackfillRecord(handle)?.status === 'ran') return
//
// and its own comment spells out the reasoning the quote sweep contradicted:
// "the absence of any record IS the 'never got the chance' state, and the next
// launch runs the job." Two one-shot jobs, one file, opposite semantics. So
// the last test here pins them together rather than pinning one of them.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openMemoryDb, migrate } from '../db'
import { quoteSweepIsComplete, quoteSweepRecord } from '../memory-runtime'

let dir: string
let db: Database.Database

const KEY = 'bug215.quoteSweep'
const setRecord = (value: unknown): void => {
  db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run(
    KEY,
    JSON.stringify(value)
  )
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bug238-'))
  const path = join(dir, 'memory.db')
  db = openMemoryDb(path)
  await migrate(db, path)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('BUG-238 — only a completed sweep latches', () => {
  it('no record at all: the sweep runs', () => {
    expect(quoteSweepRecord(db)).toBeNull()
    expect(quoteSweepIsComplete(db)).toBe(false)
  })

  it('a COMPLETED run latches — the sweep must not repeat destructive work', () => {
    // The other direction, and it matters: this sweep redacts irreversibly.
    // A fix that made it re-run every launch would be worse than the bug.
    setRecord({
      status: 'ran',
      at: '2026-09-09T00:00:00.000Z',
      callsSwept: 25,
      memoriesTouched: 36,
      quotesRedacted: 43,
      charactersRemoved: 2537,
      memoriesTotal: 73,
      rescuedByFileCheck: 0
    })
    expect(quoteSweepIsComplete(db)).toBe(true)
  })

  it('a run that swept NOTHING still latches — "ran and found nothing" is a completed run', () => {
    setRecord({ status: 'ran', at: '2026-09-09T00:00:00.000Z', callsSwept: 0, rescuedByFileCheck: 0 })
    expect(quoteSweepIsComplete(db)).toBe(true)
  })

  it('SKIPPED — connection replaced during startup: runs again next launch', () => {
    setRecord({
      status: 'skipped',
      at: '2026-09-09T00:00:00.000Z',
      reason: 'connection replaced during startup'
    })
    expect(quoteSweepIsComplete(db)).toBe(false)
  })

  it('SKIPPED — the safety refusal: runs again next launch', () => {
    // THE ONE THAT MATTERS. This is the path a transient directory-read failure
    // takes, and latching on it turned the refusal into a permanent opt-out.
    setRecord({
      status: 'skipped',
      at: '2026-09-09T00:00:00.000Z',
      reason: 'calls directory read as empty while memories exist — refusing to sweep',
      memoriesTotal: 73
    })
    expect(quoteSweepIsComplete(db)).toBe(false)
  })

  it('an unparseable record does not latch — it is not evidence the sweep completed', () => {
    db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run(KEY, '{not json')
    expect(quoteSweepRecord(db)).toBeNull()
    expect(quoteSweepIsComplete(db)).toBe(false)
  })

  it('the two one-shot jobs in this file latch the SAME way', () => {
    // The asymmetry was the finding. Pinned as text because it is a claim about
    // two call sites agreeing, which no single behavioural test can express —
    // and because the next one-shot job added here should match them both.
    const src = readFileSync(join(__dirname, '..', 'memory-runtime.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
    expect(src, 'the quote sweep must latch on a completed run').toContain(
      'if (quoteSweepIsComplete(handle)) return'
    )
    expect(src, 'the temporal backfill must latch on a completed run').toContain(
      "if (temporalBackfillRecord(handle)?.status === 'ran') return"
    )
    expect(
      src.includes('if (quoteSweepRecord(handle)) return'),
      'the presence-only latch is back — a skip would disable the sweep forever'
    ).toBe(false)
  })
})
