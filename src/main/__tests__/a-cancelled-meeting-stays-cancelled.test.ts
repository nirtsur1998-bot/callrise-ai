// BUG-221 — CallRise must not put a meeting back on someone's real calendar
// after they cancelled it there.
//
// `pushUpdateEvent` PATCHes the provider's copy. On a 404 or 410 it used to
// fall back to `pushInsertEvent`, and the comment stated the intent: "Gone on
// Google's side, recreate on the SAME calendar."
//
// "Gone" includes "the user deleted it", and the API returns the same 404
// either way. There is no signal that separates a provider losing an event
// from a person cancelling a meeting, so re-inserting takes the unrecoverable
// side of the ambiguity: the meeting reappears with its attendees and the
// provider re-notifies them. The user deleted it in Google's own UI, from their
// phone, and has no reason to suspect CallRise put it back.
//
// A NOTE ON THE SHAPE THAT WAS PROPOSED AND DOES NOT WORK, kept because the
// next person will propose it too: "on 404, check whether the local side still
// wants the event; if the user deleted it here too, let it stay gone." That
// path cannot reach this code. A locally deleted event has
// `sync.state === 'deleted'` and goes down the delete branch in events.ts,
// which issues a DELETE and never a PATCH. By the time a PATCH runs, the local
// side always wants the event — that is why it is dirty. The rule would have
// been a no-op guarding a case that was already safe.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GOOGLE = readFileSync(join(__dirname, '..', 'google.ts'), 'utf8')
const OUTLOOK = readFileSync(join(__dirname, '..', 'outlook.ts'), 'utf8')
const EVENTS = readFileSync(join(__dirname, '..', 'events.ts'), 'utf8')
const EVENTS_FS = readFileSync(join(__dirname, '..', 'events-fs.ts'), 'utf8')

/** Source with comments stripped. The prohibition is stated in prose right
 *  next to the code that avoids it, so a grep for the forbidden shape finds
 *  the warning unless comments go first — the same trap the crash-dump guard
 *  hit. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('a meeting cancelled at the provider stays cancelled', () => {
  it('THE BUG: neither provider re-inserts after a 404 on update', () => {
    for (const [name, src] of [
      ['google.ts', GOOGLE],
      ['outlook.ts', OUTLOOK]
    ] as const) {
      const c = code(src)
      const update = c.slice(c.indexOf('pushUpdateEvent'))
      const gone = update.indexOf('404')
      expect(gone, `${name}: the 404 branch in pushUpdateEvent is gone`).toBeGreaterThan(0)
      const branch = update.slice(gone, gone + 240)
      expect(
        branch,
        `${name}: pushUpdateEvent re-inserts on 404 — that re-creates a meeting the user cancelled, ` +
          'with its attendees, and the provider re-notifies them'
      ).not.toContain('pushInsertEvent')
      expect(branch, `${name}: the gone case is not reported distinguishably`).toContain(
        'remote-event-gone'
      )
    }
  })

  it('the caller unlinks the local record instead of dropping the result on the floor', () => {
    // Without this the event would sit at its previous sync state and the next
    // edit would try again, so the fix would only postpone the resurrection.
    expect(code(EVENTS)).toContain("res.error === 'remote-event-gone'")
    expect(code(EVENTS)).toMatch(/orphanEvent\(eventsDir\(\), id, 'event-gone'\)/)
  })

  it('the event itself is KEPT — the user did not ask to lose it here', () => {
    // orphanEvent deletes the link and keeps the record, with the old link
    // preserved on the orphan note as evidence. Pinned because "unlink" and
    // "delete" are one careless edit apart.
    const fn = EVENTS_FS.slice(EVENTS_FS.indexOf('export async function orphanEvent'))
    expect(fn.slice(0, 900)).toContain('delete event.provider')
    expect(fn.slice(0, 900)).toContain('delete event.externalId')
    expect(
      fn.slice(0, 900),
      'orphanEvent removes the record rather than the link'
    ).not.toMatch(/unlink|rmSync|markEventDeleted/)
  })

  it('the two ways a link dies are told apart, because the user needs different words', () => {
    expect(EVENTS_FS).toMatch(/reason: 'calendar-gone' \| 'event-gone'/)
    const note = EVENTS.slice(EVENTS.indexOf('export function orphanNote'))
    expect(note.slice(0, 900)).toContain("o.reason === 'event-gone'")
    expect(
      note.slice(0, 900),
      'the event-gone wording does not say that it was NOT put back, which is the one thing the ' +
        'user needs to know'
    ).toMatch(/not re-added/)
  })

  it('the DELETE path is untouched: an already-gone remote is still a success', () => {
    // Deleting locally something the provider has already lost must stay a
    // success, or every such deletion would retry for ever. A careless reading
    // of this fix would "correct" that too.
    expect(OUTLOOK).toMatch(/404 \|\| httpStatus\(e\) === 410\) return \{ ok: true \}/)
  })
})
