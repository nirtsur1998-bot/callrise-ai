// BUG-216 — a user who asks for an erase and then signs out must not be told
// their data is gone.
//
// `pushAll` returns at `if (!userId)` BEFORE `drainPendingScrubs` is reached.
// A scrub needs a session, so that early return is correct — what was wrong is
// what the user saw. The queued scrub never ran, never wrote state, and the
// Backup card, which read only that state, said "Backed up N minutes ago"
// indefinitely. The erase they asked for had not happened and nothing on
// screen said so.
//
// This is the same shape as BUG-203 one step further out. BUG-203 was "a
// failing scrub is invisible"; this is "a scrub that never even ran is
// invisible", and the second one is worse because there is no failure to
// report — only an absence, which is exactly what a status screen renders as
// success.
//
// The fix is that the card reads the QUEUE rather than the leftovers of a
// drain that never happened, and distinguishes "retrying" from "stopped".
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BACKUP = readFileSync(join(__dirname, '..', 'backup.ts'), 'utf8')
const CARD = readFileSync(
  join(__dirname, '..', '..', 'renderer', 'src', 'features', 'backup', 'BackupCard.tsx'),
  'utf8'
)

describe('a signed-out erase is not silent', () => {
  it('THE PREMISE: the push still returns before the drain when signed out', () => {
    // Asserted rather than assumed, because if this ever changes the card's
    // "stopped" wording becomes the lie instead of the fix. The early return
    // is CORRECT — a scrub cannot run without a session — so this test pins
    // the behaviour the UI is compensating for, not a bug to be removed.
    const push = BACKUP.slice(BACKUP.indexOf('export async function pushAll'))
    const signedOutReturn = push.indexOf("return { ok: false, error: 'not-signed-in' }")
    const drain = push.indexOf('drainPendingScrubs(client, userId)')
    expect(signedOutReturn, 'the signed-out guard is gone').toBeGreaterThan(0)
    expect(drain, 'the scrub drain is gone').toBeGreaterThan(0)
    expect(
      signedOutReturn,
      'the drain now runs before the signed-out return, so the card must stop saying "stopped"'
    ).toBeLessThan(drain)
  })

  it('the status reads the QUEUE, not what a drain that never ran left behind', () => {
    const handler = BACKUP.slice(BACKUP.indexOf("ipcMain.handle('backup:getStatus'"))
    expect(
      handler.slice(0, 1400),
      'getStatus does not read the pending-scrub queue, so a scrub that never ran is invisible'
    ).toContain('readPendingScrubs()')
  })

  it('the status says whether a scrub CAN drain at all', () => {
    const handler = BACKUP.slice(BACKUP.indexOf("ipcMain.handle('backup:getStatus'"))
    expect(handler.slice(0, 1400)).toMatch(/signedIn:/)
  })

  it('the card shows a stopped scrub immediately, not after a second failure', () => {
    // The two-failure heuristic exists so one offline push does not accuse the
    // app of losing data. Signed out there is no failure to count and never
    // will be, so waiting for a second one waits for ever.
    expect(CARD).toMatch(/scrubStoppedBySignOut[\s\S]{0,120}status\?\.signedIn === false/)
    expect(
      CARD,
      'the stopped case is not part of what makes the pending line appear'
    ).toMatch(/scrubFailedTwice \|\| scrubStoppedBySignOut/)
  })

  it('and says something DIFFERENT, because "still removing" would be a lie', () => {
    // "Still removing" implies work in progress. Nothing is in progress: the
    // push returns before the drain. The user has to be told what to do.
    expect(CARD).toContain('Sign in to finish removing')
    expect(CARD).toContain('nothing is being retried while you')
  })
})
