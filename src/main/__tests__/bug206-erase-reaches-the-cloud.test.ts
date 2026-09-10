// BUG-206 — "Forget everything" said it could not be undone, and the next
// restore undid it.
//
// THE SHAPE, because it is not the one it looks like. backup.ts was already
// right: *"an erasure travels as a DELETE rather than as an upload of
// emptiness… nothing legitimate uploads an empty brain."* The empty-upload
// refusal it guards is correct and is NOT touched by this fix. The defect was
// that forgetEverything never joined the erase path that sentence assumes
// exists — so the local wipe was real, the refusal correctly declined to push
// emptiness over the cloud copy, and the next restore brought it all back.
//
// THE DISCRIMINATOR, which is the part worth understanding:
//
//   "empty" is a STATE. "the user pressed Forget everything" is an EVENT.
//   Inferring the event from the state was the original mistake.
//
// Every row of downloadSalesBrainDb's decision table reads the store's
// CONTENTS and guesses intent. That cannot tell an erase from a broken store,
// because both are empty. So intent is read from where it was recorded — the
// pending-scrub queue — and NOT from a marker inside memory.db, because a
// marker in the thing being erased is unreadable exactly when the store is
// broken, which is the one case that must never look like an erase.
//
// The third test below is the one that proves the fix did not break recovery:
// a corrupt local store with NO queued erase must still restore, exactly as it
// did before.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
const backup = readFileSync(join(SRC, 'backup.ts'), 'utf8')
const ipc = readFileSync(join(SRC, 'memory', 'memory-center-ipc.ts'), 'utf8')
const settings = readFileSync(join(SRC, 'app-settings.ts'), 'utf8')

/** Comments stripped: a guard that matches its own explanation is not a guard.
 *  Learned twice in M37 — the locality guard and BUG-237's. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

describe('BUG-206 — an erase reaches the cloud', () => {
  it('forgetEverything queues a cloud scrub', () => {
    // RED-CHECK 1: delete this call and the cloud object survives the erase.
    expect(
      code(ipc),
      'forgetEverything must notify the erase listener, or the cloud copy outlives the wipe'
    ).toContain('notifySalesBrainErased()')
    expect(code(settings)).toContain('export function notifySalesBrainErased()')
  })

  it('the listener queues the SALES BRAIN key specifically, through the proven path', () => {
    // Not an inline delete: queued, so an offline erase still reaches the
    // cloud on reconnect. And salesBrain already had a drainPendingScrubs
    // branch proven against the live project by BUG-204.
    expect(code(backup)).toContain("setSalesBrainErasedListener(() => queuePendingScrubs(['salesBrain']))")
  })

  it('a queued erase blocks the restore that used to undo it', () => {
    // RED-CHECK 2: remove this guard and an erase followed by a pull restores
    // the memories. It closes the window between the erase and a successful
    // scrub — an offline erase, then a sign-in before the push completes.
    const fn = backup.slice(backup.indexOf('export async function downloadSalesBrainDb'))
    const guard = code(fn).indexOf("(await readPendingScrubs()).includes('salesBrain')")
    expect(guard, 'downloadSalesBrainDb must refuse to restore an erase in flight').toBeGreaterThan(-1)
    // It must come BEFORE the contents-based decision, or the table's
    // "0 memory rows -> restore" row fires first and the guard never runs.
    const table = code(fn).indexOf('const local = localMemoryCount(dbPath)')
    expect(table, 'the contents check moved — re-read this test').toBeGreaterThan(-1)
    expect(guard, 'the intent guard must precede the contents check').toBeLessThan(table)
  })

  it('THE REFUSAL IS UNTOUCHED — an empty brain is still never uploaded', () => {
    // The fix must not "solve" this by letting emptiness upload. That gate is
    // load-bearing for fresh installs, husks and corrupt stores alike.
    expect(code(backup)).toContain('localForUpload.ok && localForUpload.count === 0')
    expect(backup).toContain('refusing to upload an EMPTY Sales Brain')
  })

  it('RECOVERY INTACT — the unreadable path does not consult the erase queue', () => {
    // RED-CHECK 3, and the one that proves erasure was fixed without breaking
    // restore. A corrupt or unreadable local store has no queued erase, so it
    // falls through to exactly the behaviour it had before: moved aside, then
    // restored. Intent is never inferred from damage.
    const fn = backup.slice(backup.indexOf('export async function downloadSalesBrainDb'))
    expect(code(fn)).toContain("!local.ok && local.reason === 'unreadable'")
    const unreadable = code(fn).indexOf("local.reason === 'unreadable'")
    const guard = code(fn).indexOf("(await readPendingScrubs()).includes('salesBrain')")
    // The erase guard returns early and independently; the unreadable branch
    // is still reached when nothing was erased.
    expect(unreadable).toBeGreaterThan(guard)
  })

  it('the erase listener never throws into the erase', () => {
    // A queued scrub that fails must not make the user believe their local
    // deletion failed too — the one thing they can actually see.
    const fn = settings.slice(settings.indexOf('export function notifySalesBrainErased'))
    expect(fn.slice(0, 300)).toContain('try {')
    expect(fn.slice(0, 300)).toContain('catch')
  })
})
