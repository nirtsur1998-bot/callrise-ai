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
describe('BUG-236 — an unreadable call file is not a deleted call', () => {
  // THE HOLE THIS CLOSES, and it is the one that decided the release rollout.
  //
  // `liveCallIds` comes from listCalls, whose per-file reader ends
  // `catch { return null } // skip unreadable / corrupt file` (calls-fs.ts).
  // So a call whose file cannot be read for a moment is INDISTINGUISHABLE from
  // a call the user deleted — and this sweep runs once, on first launch after
  // an upgrade, on Windows, where a file briefly locked by antivirus is
  // ordinary. It would blank that call's quotes permanently, on a call that
  // still exists, and nothing anywhere would record that it had.
  //
  // The pre-existing precondition only catches the read failing ENTIRELY (an
  // empty list while memories exist). A PARTIAL read walks straight through
  // it, and a partial read is both likelier and quieter.

  it('does NOT redact a call the listing missed but the filesystem still has', () => {
    insertMemory(
      db,
      candidate({
        statement: 'Budget lands in March',
        evidence: [{ type: 'transcript', callId: 'locked-1', quote: 'our budget lands in March' }]
      }),
      embedding(11)
    )

    // The listing came back without it — an antivirus lock, a transient EBUSY,
    // a corrupt parse. The filesystem says otherwise.
    const r = redactOrphanedQuotes(db, new Set(), (callId) => callId !== 'locked-1')

    expect(r.quotesRedacted, 'a still-present call had its quote destroyed').toBe(0)
    expect(r.callsSwept).toBe(0)
    expect(r.rescuedByFileCheck).toBe(1)
    const e = listMemories(db)[0].evidence[0]
    expect(e.type === 'transcript' && e.quote).toBe('our budget lands in March')
  })

  it('still redacts a call that is genuinely gone from both instruments', () => {
    insertMemory(
      db,
      candidate({
        statement: 'Mentioned a competitor',
        evidence: [{ type: 'transcript', callId: 'deleted-1', quote: 'we also looked at Acme' }]
      }),
      embedding(12)
    )

    const r = redactOrphanedQuotes(db, new Set(), () => true)

    expect(r.quotesRedacted).toBe(1)
    expect(r.rescuedByFileCheck).toBe(0)
    const e = listMemories(db)[0].evidence[0]
    expect(e.type === 'transcript' && e.quote).toBe('')
    // and the FACT survives, which is the whole design of BUG-215
    expect(listMemories(db)[0].statement).toBe('Mentioned a competitor')
  })

  it('reports the rescue count, because a silent rescue is a silent warning', () => {
    // The number is the rollout's only real signal: above zero means the calls
    // listing disagreed with the filesystem on that machine, so the sweep's
    // input cannot be trusted there. It is recorded in memory_meta rather than
    // only logged, so it can be read back off a profile afterwards.
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      insertMemory(
        db,
        candidate({
          statement: `Fact ${id}`,
          evidence: [{ type: 'transcript', callId: `call-${id}`, quote: `quote ${id}` }]
        }),
        embedding(20 + i)
      )
    }
    // Two of the three are really gone; one was merely unreadable.
    const r = redactOrphanedQuotes(db, new Set(), (callId) => callId !== 'call-b')
    expect(r.rescuedByFileCheck).toBe(1)
    expect(r.callsSwept).toBe(2)
    const kept = listMemories(db).find((m) => m.statement === 'Fact b')?.evidence[0]
    expect(kept && kept.type === 'transcript' && kept.quote).toBe('quote b')
  })

  it('without the check, the old destructive behaviour is exactly what happens', () => {
    // Kept deliberately: it documents what the sweep does when nobody passes
    // the second instrument, which is what shipped before this fix and what
    // the pure unit tests above still exercise.
    insertMemory(
      db,
      candidate({
        statement: 'Would have been destroyed',
        evidence: [{ type: 'transcript', callId: 'locked-2', quote: 'still here' }]
      }),
      embedding(13)
    )
    expect(redactOrphanedQuotes(db, new Set()).quotesRedacted).toBe(1)
  })
})
