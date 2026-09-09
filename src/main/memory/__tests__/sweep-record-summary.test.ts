// The whitelist that lets the ramp criterion leave the machine.
//
// The record is safe to emit verbatim TODAY — every field is a status literal,
// an ISO timestamp, one of two fixed reason literals, or an integer. These
// tests exist because "safe today" is not a property of the code that reads it:
//
//   1. memory-runtime parses the row as an UNCHECKED CAST, so a record written
//      by a later version, or hand-edited, comes back typed as the interface
//      with all its extra keys intact.
//   2. `reason` is safe as a known literal and unsafe as a pass-through field.
//      The sibling record twenty lines away in the same file interpolates
//      filesystem error messages into its own reason; one edit in that
//      direction turns this into a leak.
//
// So the tests are written against a HOSTILE record rather than a well-formed
// one. A well-formed record proves the happy path and nothing about the guard.
import { describe, expect, it } from 'vitest'
import {
  KNOWN_SKIP_REASONS,
  SWEEP_SUMMARY_KEYS,
  explainSweepSummary,
  projectSweepRecord,
  withoutErasedScale
} from '../sweep-record-summary'

const QUOTE = "customer said their card is 4111 1111 1111 1111 don't tell anyone"
const PATH = 'C:\\Users\\Dana\\Desktop\\private-note.txt'

const GOOD = {
  status: 'ran' as const,
  at: '2026-09-08T08:54:52.846Z',
  callsSwept: 25,
  memoriesTouched: 36,
  quotesRedacted: 43,
  charactersRemoved: 2537,
  memoriesTotal: 73,
  rescuedByFileCheck: 0
}

describe('projectSweepRecord — the whitelist', () => {
  it('keeps every known field of a well-formed record', () => {
    expect(projectSweepRecord(GOOD)).toEqual(GOOD)
  })

  it('DROPS keys it has never heard of, and reports only how many', () => {
    // The core case. A later version adding a field must not be able to ship
    // it out of a user's machine without someone deciding it is safe.
    const hostile = {
      ...GOOD,
      quote: QUOTE,
      callId: 'call-2026-09-01-abc123',
      lastError: `ENOENT: no such file or directory, open '${PATH}'`,
      contactName: 'Dana Whitfield'
    }
    const out = projectSweepRecord(hostile)!
    const serialised = JSON.stringify(out)
    expect(serialised).not.toContain(QUOTE)
    expect(serialised).not.toContain('call-2026-09-01-abc123')
    expect(serialised).not.toContain(PATH)
    expect(serialised).not.toContain('Dana')
    // The COUNT is emitted, never the names — a key name invented by a future
    // version is itself content nobody has vetted.
    expect(out.unknownKeysDropped).toBe(4)
    expect(serialised).not.toContain('contactName')
    expect(Object.keys(out).every((k) => [...SWEEP_SUMMARY_KEYS, 'unknownKeysDropped'].includes(k))).toBe(true)
  })

  it('keeps both reasons the code can actually produce', () => {
    for (const reason of KNOWN_SKIP_REASONS) {
      expect(projectSweepRecord({ status: 'skipped', at: GOOD.at, reason })?.reason).toBe(reason)
    }
  })

  it('REPLACES any other reason rather than passing it through', () => {
    const out = projectSweepRecord({
      status: 'skipped',
      at: GOOD.at,
      reason: `could not read ${PATH}: transcript said "${QUOTE}"`
    })!
    expect(out.reason).toBe('(unrecognised reason — not emitted)')
    expect(JSON.stringify(out)).not.toContain(PATH)
    expect(JSON.stringify(out)).not.toContain(QUOTE)
  })

  it('rejects a non-integer where a count belongs, including a string that looks like one', () => {
    const out = projectSweepRecord({
      status: 'ran',
      at: GOOD.at,
      callsSwept: '25' as unknown as number,
      quotesRedacted: 1.5,
      charactersRemoved: Number.NaN,
      memoriesTotal: Number.POSITIVE_INFINITY,
      rescuedByFileCheck: 0
    })!
    expect(out.callsSwept).toBeUndefined()
    expect(out.quotesRedacted).toBeUndefined()
    expect(out.charactersRemoved).toBeUndefined()
    expect(out.memoriesTotal).toBeUndefined()
    expect(out.rescuedByFileCheck).toBe(0)
  })

  it('rejects a timestamp that is not an ISO instant — the only string that passes through', () => {
    expect(projectSweepRecord({ ...GOOD, at: `2026-09-08 ${QUOTE}` })?.at).toBeUndefined()
    expect(projectSweepRecord({ ...GOOD, at: PATH })?.at).toBeUndefined()
    expect(projectSweepRecord({ ...GOOD, at: '2026-09-08T08:54:52.846Z' })?.at).toBe(GOOD.at)
  })

  it('returns null for anything that is not a sweep record', () => {
    expect(projectSweepRecord(null)).toBeNull()
    expect(projectSweepRecord('a string')).toBeNull()
    expect(projectSweepRecord([GOOD])).toBeNull()
    expect(projectSweepRecord({ status: 'something-else' })).toBeNull()
    expect(projectSweepRecord({ callsSwept: 25 })).toBeNull()
  })
})

describe('explainSweepSummary — a non-zero must read as a problem', () => {
  it('a non-zero says PROBLEM and says what it means', () => {
    const text = explainSweepSummary(projectSweepRecord({ ...GOOD, rescuedByFileCheck: 3 }))
    expect(text).toContain('PROBLEM')
    expect(text).toContain('3')
    expect(text).toContain('unreliable')
  })

  it('a zero over a REAL population is called the healthy result', () => {
    const text = explainSweepSummary(projectSweepRecord(GOOD))
    expect(text).toContain('healthy')
    expect(text).toContain('25')
  })

  it('a zero over NOTHING is called not-evidence, not reassurance', () => {
    // The trap this whole criterion turns on. A fresh install sweeps nothing
    // and records 0; reported as reassurance, that is how a ramp gets approved
    // on no evidence at all.
    const text = explainSweepSummary(
      projectSweepRecord({ status: 'ran', at: GOOD.at, callsSwept: 0, rescuedByFileCheck: 0 })
    )
    expect(text).toContain('examined nothing')
    expect(text).toContain('Not evidence')
    expect(text).not.toContain('healthy')
  })

  it('a record with no rescue field says absent is not zero', () => {
    const { rescuedByFileCheck: _drop, ...old } = GOOD
    const text = explainSweepSummary(projectSweepRecord(old))
    expect(text).toContain('Absent is not zero')
  })

  it('a skipped sweep says it will retry and that deleted calls may still hold quotes', () => {
    const text = explainSweepSummary(
      projectSweepRecord({ status: 'skipped', at: GOOD.at, reason: KNOWN_SKIP_REASONS[1] })
    )
    expect(text).toContain('SKIPPED')
    expect(text).toContain('retry')
  })

  it('no record at all says so', () => {
    expect(explainSweepSummary(null)).toContain('has not completed')
  })
})

describe('withoutErasedScale — the record outlives "Forget everything"', () => {
  // forgetEverything deliberately does not wipe memory_meta (it is app state,
  // not memory content), so the sweep's record survives an erase. Without
  // this, a user who confirmed "This cannot be undone" and then sent a support
  // bundle would ship a precise description of the size and shape of what they
  // had just erased — no content, but "43 quotes, 2,537 characters, 73
  // memories" is not nothing.
  const s = projectSweepRecord(GOOD)!

  it('drops the four fields that quantify what the brain held', () => {
    const out = withoutErasedScale(s)!
    expect(out.memoriesTouched).toBeUndefined()
    expect(out.quotesRedacted).toBeUndefined()
    expect(out.charactersRemoved).toBeUndefined()
    expect(out.memoriesTotal).toBeUndefined()
  })

  it('KEEPS the ramp criterion, or a post-erase machine reports a trivial zero', () => {
    // The trade-off, asserted so it cannot be "tidied" later: dropping
    // callsSwept would make every erased machine indistinguishable from a
    // fresh install, and the criterion would go quiet exactly where someone
    // was most likely to be looking.
    const out = withoutErasedScale(s)!
    expect(out.callsSwept).toBe(25)
    expect(out.rescuedByFileCheck).toBe(0)
    expect(out.status).toBe('ran')
    expect(explainSweepSummary(out)).toContain('healthy result')
  })

  it('does not mutate the record it was given', () => {
    withoutErasedScale(s)
    expect(s.memoriesTotal).toBe(73)
  })
})
