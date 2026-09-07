// BUG-205 — the Sales Brain upload follows the TRANSCRIPTS toggle, not only
// its own.
//
// WHY, and it is a behaviour decision rather than a wording one. A Sales Brain
// memory's `evidence` is a VERBATIM span of the transcript, up to 400
// characters of the buyer's actual words (memory/extraction.ts). memory.db
// uploads whole. So a user who deliberately switched "Call recordings &
// transcripts" OFF — an explicit decision about verbatim buyer speech — still
// had word-for-word quotes going to their cloud account, labelled only "Sales
// Brain memories".
//
// Seven pieces of copy tried to describe that truthfully. Five drafts were
// written and all five came back false or misleading, always broken by this one
// fact. That is what turned it from a copy problem into a behaviour problem,
// and the founder's decision of 2026-09-07 was to honour the toggle the user
// already set rather than keep explaining why it does not apply:
//
//   "Someone who switches transcript backup off has made a decision about
//    verbatim buyer speech, and we're currently ignoring it in the one store
//    that holds the most sensitive form of it."
//
// Same gating, and the same reason, as the objection review queue.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandDisabledScrubKeys } from '../backup'

const BACKUP = readFileSync(join(__dirname, '..', 'backup.ts'), 'utf8')

describe('the Sales Brain upload is gated on the transcripts toggle', () => {
  it('the push requires BOTH toggles, not just its own', () => {
    // A source check, because the gate lives inside pushAll, which needs a
    // signed-in client and a real profile to run. The assertion is on the
    // condition itself so a future edit that drops one half goes red here.
    expect(
      BACKUP,
      'the Sales Brain upload must require the transcripts toggle as well as its own'
    ).toContain('if (syncScope.salesBrain && syncScope.transcripts) {')
    // There is exactly ONE bare `if (syncScope.salesBrain)` left, and it is the
    // RESTORE, which stays ungated deliberately: downloading the user's own
    // brain back onto their own device is not an egress, and gating it would
    // cost someone their memories on a new machine for no privacy gain.
    //
    // Asserting on the whole file demanded the wrong change and went red on
    // exactly that when first written. Slicing "up to the download call" was
    // also wrong, because the restore's gate sits immediately BEFORE that call
    // and so fell inside the slice. Counting, and then naming what the single
    // survivor guards, is the assertion that says what is actually meant.
    const bare = [...BACKUP.matchAll(/if \(syncScope\.salesBrain\) \{/g)]
    expect(
      bare.length,
      'more than one bare `if (syncScope.salesBrain)` gate — the transcripts half was dropped ' +
        'from the push, or a new ungated consumer appeared'
    ).toBe(1)
    expect(
      BACKUP.slice(bare[0].index, bare[0].index + 200),
      'the one ungated salesBrain gate is no longer the restore — check what it now guards'
    ).toContain('downloadSalesBrainDb')
  })

  it('the gate sits immediately above the upload it governs', () => {
    // Guards against the condition surviving while the CALL moves out from
    // under it, which is how a gate becomes decorative.
    const i = BACKUP.indexOf('if (syncScope.salesBrain && syncScope.transcripts) {')
    const j = BACKUP.indexOf('uploadSalesBrainDb(client, userId)', i)
    expect(i, 'the gate is gone').toBeGreaterThan(0)
    expect(j, 'the upload is no longer inside the gate').toBeGreaterThan(i)
    expect(j - i, 'the upload has drifted out of the block the gate opens').toBeLessThan(400)
  })
})

describe('switching transcripts off also removes the brain already uploaded', () => {
  it('THE POINT: disabling transcripts queues a salesBrain scrub too', () => {
    // Without this the gate stops FUTURE uploads and leaves the verbatim
    // quotes already sitting in the account — BUG-200's exact shape
    // reappearing inside its own fix.
    expect(expandDisabledScrubKeys(['transcripts'])).toEqual(['transcripts', 'salesBrain'])
  })

  it('does not duplicate when both were switched off together', () => {
    expect(expandDisabledScrubKeys(['transcripts', 'salesBrain'])).toEqual([
      'transcripts',
      'salesBrain'
    ])
  })

  it('leaves every other combination exactly as it was', () => {
    // The expansion must be narrow. Adding a scrub nobody asked for would
    // delete data the user still wants, which is worse than the bug.
    expect(expandDisabledScrubKeys(['salesBrain'])).toEqual(['salesBrain'])
    expect(expandDisabledScrubKeys(['contacts'])).toEqual(['contacts'])
    expect(expandDisabledScrubKeys([])).toEqual([])
    expect(expandDisabledScrubKeys(['knowledgeBase', 'attachments'])).toEqual([
      'knowledgeBase',
      'attachments'
    ])
  })

  it('is wired to the listener, not merely defined', () => {
    // A pure function nobody calls is the most convincing kind of dead guard:
    // its own tests pass forever.
    expect(
      BACKUP,
      'expandDisabledScrubKeys is defined but the disabled-scope listener does not use it'
    ).toContain('setSyncScopeDisabledListener((keys) => queuePendingScrubs(expandDisabledScrubKeys(keys)))')
  })
})
