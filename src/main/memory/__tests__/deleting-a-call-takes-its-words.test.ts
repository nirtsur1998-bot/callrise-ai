// BUG-215 — deleting a call takes the buyer's words out of the Sales Brain,
// and leaves the fact.
//
// `deleteCall` promises, in its own words, that "a deleted call must not
// retain buyer words". It already purges the objection queue, the conflict
// copies and the call journal for exactly that reason. The Sales Brain was the
// one store it never reached, and a memory's evidence is a verbatim span of
// the transcript stamped with that call's id.
//
// MEASURED ON THE FOUNDER'S OWN STORE before any of this was written:
//   73 memories, 81 transcript evidence entries, 5,532 characters of verbatim
//   buyer speech, and 25 of the 43 cited calls ALREADY DELETED.
// The backlog was present, not hypothetical, and that is what chose the design.
//
// WHY REDACT RATHER THAN DELETE THE MEMORY. Deleting everything a call taught
// costs a median of one fact per call and up to five, and none of those facts
// is something the user chose to delete: they deleted a recording and would be
// charged learning. Redaction satisfies the promise on 68 of 69 measured rows
// without destroying a fact.
//
// WHY THE ENTRY SURVIVES, BLANKED, rather than being removed: distinctEpisodeCount
// keys on the callId and never reads the quote, so promotion thresholds and
// decay resistance keep their values. Removing the entry would demote a memory
// sitting at the 2-episode threshold — a fact quietly weakened as a side
// effect of deleting a recording.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryDb, migrate } from '../db'
import {
  insertMemory,
  listMemories,
  listMemoriesByCallId,
  redactCallQuotes,
  redactOrphanedQuotes
} from '../memories-store'
import type { MemoryCandidate } from '../types'

let dir: string
let db: Database.Database

function embedding(seed: number): Float32Array {
  return new Float32Array(384).fill(seed / 1000)
}

function candidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    scope: 'rep',
    category: 'selling-pattern',
    statement: 'Opens with a question',
    confidence: 0.8,
    importance: 6,
    source: 'auto',
    evidence: [{ type: 'transcript', callId: 'call-A', quote: 'so what made you take the call' }],
    ...over
  } as MemoryCandidate
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'redact-quotes-'))
  const path = join(dir, 'memory.db')
  db = openMemoryDb(path)
  await migrate(db, path)
})
afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('redacting one call', () => {
  it('THE PROMISE: the words go and the fact stays', () => {
    insertMemory(db, candidate(), embedding(1))

    const r = redactCallQuotes(db, 'call-A')

    // Computed, not hardcoded: the first version asserted 29 against a
    // 30-character quote, which is a made-up number in a row of measured ones.
    const QUOTE = 'so what made you take the call'
    expect(r).toEqual({
      memoriesTouched: 1,
      quotesRedacted: 1,
      charactersRemoved: QUOTE.length
    })
    const [m] = listMemories(db)
    expect(m.statement, 'the FACT was destroyed — that is the option we did not choose').toBe(
      'Opens with a question'
    )
    const e = m.evidence[0]
    expect(e.type).toBe('transcript')
    if (e.type !== 'transcript') throw new Error('unreachable')
    expect(e.quote, "the buyer's words survived the deletion").toBe('')
    expect(e.redactedAt, 'nothing records that this was redacted').toBeTruthy()
  })

  it('the evidence ENTRY survives, so the episode count is unchanged', () => {
    // Removing the entry would drop a memory at the 2-episode promotion
    // threshold back to 1 — a fact demoted as a side effect of deleting a
    // recording. This is the reason the entry is blanked rather than dropped.
    insertMemory(
      db,
      candidate({
        evidence: [
          { type: 'transcript', callId: 'call-A', quote: 'first' },
          { type: 'transcript', callId: 'call-B', quote: 'second' }
        ]
      }),
      embedding(2)
    )

    redactCallQuotes(db, 'call-A')

    const [m] = listMemories(db)
    expect(m.evidence, 'an evidence entry was removed, not blanked').toHaveLength(2)
    expect(listMemoriesByCallId(db, 'call-A'), 'the episode stopped being findable').toHaveLength(1)
  })

  it('touches only the deleted call', () => {
    insertMemory(
      db,
      candidate({
        evidence: [
          { type: 'transcript', callId: 'call-A', quote: 'from A' },
          { type: 'transcript', callId: 'call-B', quote: 'from B' }
        ]
      }),
      embedding(3)
    )

    redactCallQuotes(db, 'call-A')

    const ev = listMemories(db)[0].evidence
    expect(ev[0].type === 'transcript' && ev[0].quote).toBe('')
    expect(
      ev[1].type === 'transcript' && ev[1].quote,
      "another call's quote was redacted too"
    ).toBe('from B')
  })

  it('is idempotent and reports nothing the second time', () => {
    insertMemory(db, candidate(), embedding(4))
    expect(redactCallQuotes(db, 'call-A').quotesRedacted).toBe(1)
    expect(
      redactCallQuotes(db, 'call-A'),
      'a second pass counted work it did not do'
    ).toEqual({ memoriesTouched: 0, quotesRedacted: 0, charactersRemoved: 0 })
  })
})

describe('the backlog sweep', () => {
  it('redacts quotes whose call is gone and leaves the live ones', () => {
    insertMemory(db, candidate({ evidence: [{ type: 'transcript', callId: 'gone-1', quote: 'x' }] }), embedding(5))
    insertMemory(
      db,
      candidate({
        statement: 'Second',
        evidence: [{ type: 'transcript', callId: 'live-1', quote: 'kept' }]
      }),
      embedding(6)
    )

    const r = redactOrphanedQuotes(db, new Set(['live-1']))

    expect(r.callsSwept).toBe(1)
    expect(r.quotesRedacted).toBe(1)
    const byStatement = Object.fromEntries(listMemories(db).map((m) => [m.statement, m.evidence[0]]))
    expect(byStatement['Opens with a question'].type === 'transcript' && byStatement['Opens with a question'].quote).toBe('')
    expect(
      byStatement['Second'].type === 'transcript' && byStatement['Second'].quote,
      'a live call had its quote redacted'
    ).toBe('kept')
  })

  it('never touches chat or onboarding sources — no deletion promise was made about them', () => {
    // Their ids are prefixed and they are not calls. A user who deletes a call
    // has said nothing about their Rise threads or their onboarding answers.
    insertMemory(
      db,
      candidate({ evidence: [{ type: 'transcript', callId: 'assistant:abc', quote: 'chat words' }] }),
      embedding(7)
    )
    insertMemory(
      db,
      candidate({
        statement: 'From onboarding',
        evidence: [{ type: 'transcript', callId: 'onboarding:1', quote: 'setup words' }]
      }),
      embedding(8)
    )

    const r = redactOrphanedQuotes(db, new Set())

    expect(r.callsSwept, 'a chat or onboarding source was swept as if it were a call').toBe(0)
    for (const m of listMemories(db)) {
      const e = m.evidence[0]
      expect(e.type === 'transcript' && e.quote).not.toBe('')
    }
  })

  it('an empty live-call set redacts every real call — which is why the caller refuses that case', () => {
    // Documented here rather than only in the caller: this function does what
    // it is told. The judgement about whether an empty calls directory means
    // "everything was deleted" or "the read failed" belongs to the caller, and
    // memory-runtime refuses it. This test pins the dangerous behaviour so the
    // guard upstream can never look unnecessary.
    insertMemory(db, candidate(), embedding(9))
    expect(redactOrphanedQuotes(db, new Set()).quotesRedacted).toBe(1)
  })
})
