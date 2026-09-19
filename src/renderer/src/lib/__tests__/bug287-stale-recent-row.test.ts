// @vitest-environment happy-dom
//
// BUG-287 — a sidebar/palette RECENT row for a call, contact or deal that no
// longer exists did nothing at all when clicked: the click navigated, the
// screen mounted, discovered the record was gone, and bounced back to the
// list with no message and — the part that made it recur — the trail entry
// itself was never pruned, so the exact same click did the exact same
// nothing the next time too.
//
// Driven on the running app before any fix (main `e955ff3`): delete a call,
// wait out the 6-second undo, click its still-listed RECENT row —
// `heading: "Past Calls"` before and after, hash unchanged. Frame-sampled to
// tell "never opened" from "opened, found nothing, bounced": the missing-call
// skeleton DID mount (shimmer 0 -> 6 -> 20 -> 0) on the way back to the list.
//
// The refuted hypothesis (the Mac session's, and mine originally): "nothing
// checks existence." Wrong — CallDetail's `window.api.calls.get(callId)`
// DOES check, `.find()`/`.some()` over an already-loaded list for contacts
// and deals DOES check. What was missing was the RESPONSE: no message, and
// nothing ever called the `removeRecentlyViewed` this file already exported
// with zero callers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getRecentlyViewed,
  recordRecentlyViewed,
  removeRecentlyViewed,
  type RecentItem
} from '../recentlyViewed'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

function idsOf(items: RecentItem[]): string[] {
  return items.map((i) => i.id)
}

describe('removeRecentlyViewed — exported with zero callers before this bug, now the actual fix', () => {
  it('removes exactly the matching kind+id, nothing else', () => {
    recordRecentlyViewed('call', 'c1', 'Call one')
    recordRecentlyViewed('call', 'c2', 'Call two')
    recordRecentlyViewed('contact', 'c1', 'A contact that happens to share an id with a call')

    removeRecentlyViewed('call', 'c1')

    const left = getRecentlyViewed()
    expect(idsOf(left).sort()).toEqual(['c1', 'c2'])
    // the surviving 'c1' is the CONTACT, not the call — kind matters, not just id
    expect(left.find((i) => i.id === 'c1')?.kind).toBe('contact')
  })

  it('removing an id that was never there is a safe no-op', () => {
    recordRecentlyViewed('deal', 'd1', 'A deal')
    expect(() => removeRecentlyViewed('deal', 'no-such-id')).not.toThrow()
    expect(idsOf(getRecentlyViewed())).toEqual(['d1'])
  })

  it('removing from an empty trail is a safe no-op', () => {
    expect(() => removeRecentlyViewed('call', 'x')).not.toThrow()
    expect(getRecentlyViewed()).toEqual([])
  })

  it('the removed row cannot be clicked back into existence — a later record() with the same id starts fresh', () => {
    recordRecentlyViewed('call', 'c1', 'Original title')
    removeRecentlyViewed('call', 'c1')
    expect(getRecentlyViewed()).toEqual([])
    // recording again (the record was legitimately reopened/recreated) works
    // exactly as it would for a never-seen id — removal isn't a tombstone.
    recordRecentlyViewed('call', 'c1', 'Reopened')
    expect(getRecentlyViewed()[0]).toMatchObject({ id: 'c1', label: 'Reopened' })
  })
})

describe('the trail change is observable live — the sidebar and the command palette both listen for it', () => {
  it('removeRecentlyViewed fires the same change event recordRecentlyViewed does', async () => {
    const { CHANGE_EVENT } = await import('../recentlyViewed')
    recordRecentlyViewed('call', 'c1', 'x')
    let fired = 0
    window.addEventListener(CHANGE_EVENT, () => (fired += 1))
    removeRecentlyViewed('call', 'c1')
    expect(fired).toBe(1)
  })
})
