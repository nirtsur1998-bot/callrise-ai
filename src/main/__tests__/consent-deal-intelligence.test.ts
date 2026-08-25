// BUG-115 — the Deal Intelligence Radar Report kept the buyer's verbatim words
// on disk after consent was revoked.
//
// This is the BUG-014 -> BUG-028 shape a THIRD time, and this instance is two
// statements away from the fix that closed the second one. In LiveView's
// handleSaved, `clips.flush(callId)` (which goes through addBookmark, and so
// through applyConsentRetention) sits immediately above
// `window.api.calls.saveDealIntelligence(...)`, which had no gate at all.
//
// The payload is the buyer's own speech: DealNudgeRecord.evidenceQuote is up to
// 400 characters, `evidenceRole: 'other'` marks it as the other party's, and
// deal-tier1's prompt asks the model for "the exact quote, word for word ...
// Never paraphrase or invent it." Up to 200 of them per call. They then render
// straight back to the user in RadarReport.tsx, so a revoked call showed a
// rep-only transcript above a panel quoting the buyer verbatim.
//
// WHY THE STRIP DROPS THE WHOLE NUDGE rather than blanking the quote:
// sanitizeDealNudgeRecord treats a falsy evidenceQuote as a malformed record
// and returns null for it (calls-fs.ts:2145), so a blanked quote would be
// dropped on the next round-trip anyway. Dropping it outright is the same
// answer applyConsentRetention already gives for bookmarks, and matches
// callBackupPayload's existing rule for coaching evidence: keep the score and
// the comment, drop the verbatim quote. healthScoreHistory is numeric and stays.
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCall, getCall, setCallDealIntelligence } from '../calls-fs'

const BUYER_WORDS = 'Honestly, our budget for this quarter is already committed.'
const REP_WORDS = 'I hear you — what would need to change for next quarter?'

function report(): unknown {
  return {
    nudges: [
      {
        id: 'n1',
        type: 'risk',
        subtype: 'budget',
        confidence: 0.8,
        evidenceQuote: BUYER_WORDS,
        evidenceRole: 'other',
        suggestedCue: 'Ask about next quarter.',
        atMs: 1000
      },
      {
        id: 'n2',
        // 'tactical', not 'signal': DEAL_NUDGE_TYPES is
        // ['risk','opportunity','tactical'] and sanitizeDealNudgeRecord drops
        // anything else. The first draft of this fixture used 'signal', and
        // the "keeps everything when the other party DID consent" control is
        // what caught it — without that control the whole file would have been
        // tuned to a broken expectation.
        type: 'tactical',
        subtype: 'discovery',
        confidence: 0.7,
        evidenceQuote: REP_WORDS,
        evidenceRole: 'rep',
        suggestedCue: 'Good open question.',
        atMs: 2000
      }
    ],
    healthScoreHistory: [{ atMs: 1000, score: 42, trajectory: 'down' }]
  }
}

describe('consent retention covers the Deal Intelligence record (BUG-115)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-di-consent-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A call whose buyer capture was REVOKED — recordOtherParty is not true. */
  async function revokedCall(): Promise<string> {
    const saved = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [
        { speaker: 0, channel: 0, text: 'Rep speaking.' },
        { speaker: 1, channel: 1, text: BUYER_WORDS }
      ],
      consent: {
        status: 'consented',
        method: 'verbal-on-call',
        recordOtherParty: false,
        jurisdiction: 'one-party',
        decidedAt: new Date().toISOString()
      }
    })
    return saved.id
  }

  it('never writes the other party’s verbatim quote to disk', async () => {
    const id = await revokedCall()

    await setCallDealIntelligence(dir, id, report())

    // Assert on the FILE, not on the writer's return value. Species 28: the
    // write path and the read path can disagree, and every observation of a
    // returned object is an observation of the write path only.
    const raw = await readFile(join(dir, `${id}.json`), 'utf8')
    expect(raw).not.toContain(BUYER_WORDS)

    // ...and the guard must be a strip, not a wipe: the rep's own nudge and the
    // numeric health curve are not the buyer's personal data and must survive.
    expect(raw).toContain(REP_WORDS)
  })

  it('surfaces only the rep-attributed nudge on read', async () => {
    const id = await revokedCall()
    await setCallDealIntelligence(dir, id, report())

    const call = await getCall(dir, id)
    const nudges = call?.dealIntelligence?.nudges ?? []

    // Non-empty first — otherwise every property below is vacuously true
    // (species 6), and a strip-everything bug would read as a pass.
    expect(nudges.length).toBeGreaterThan(0)
    expect(nudges.map((n) => n.id)).toEqual(['n2'])
    expect(nudges.every((n) => n.evidenceRole === 'rep')).toBe(true)
    expect(call?.dealIntelligence?.healthScoreHistory).toHaveLength(1)
  })

  it('heals a record already on disk from before this fix, on the next read', async () => {
    const id = await revokedCall()
    await setCallDealIntelligence(dir, id, report())

    // Simulate the pre-fix state: put the leaked quote back into the raw file
    // behind the write guard, exactly as a build without this fix would have
    // left it. This is what makes the read-path half load-bearing rather than
    // redundant — existing users already have these files.
    const path = join(dir, `${id}.json`)
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    onDisk.dealIntelligence = report()
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(path, JSON.stringify(onDisk), 'utf8')
    )
    expect(await readFile(path, 'utf8')).toContain(BUYER_WORDS) // the leak is really there

    const call = await getCall(dir, id)
    const quotes = (call?.dealIntelligence?.nudges ?? []).map((n) => n.evidenceQuote)
    expect(quotes).not.toContain(BUYER_WORDS)
  })

  it('keeps everything when the other party DID consent', async () => {
    const saved = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [{ speaker: 1, channel: 1, text: BUYER_WORDS }],
      consent: {
        status: 'consented',
        method: 'verbal-on-call',
        recordOtherParty: true,
        jurisdiction: 'two-party',
        decidedAt: new Date().toISOString()
      }
    })
    await setCallDealIntelligence(dir, saved.id, report())

    const call = await getCall(dir, saved.id)
    const nudges = call?.dealIntelligence?.nudges ?? []

    // The control. Without it, a guard that stripped unconditionally would pass
    // every assertion above while silently destroying consented data.
    expect(nudges.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(nudges.map((n) => n.evidenceQuote)).toContain(BUYER_WORDS)
  })
})
