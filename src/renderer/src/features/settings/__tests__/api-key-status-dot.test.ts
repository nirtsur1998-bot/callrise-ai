// BUG-143 follow-up (2026-08-30) — the API keys card must not say "Connected"
// about a key that never answered.
//
// THE FIELD FAILURE, found by the founder doing by hand the check I had
// automated badly: they typed `junk` into the OpenAI card and clicked Save. The
// card came back with a green dot reading **"Connected"**, a green tick reading
// **"Configured"**, and **"Saved — takes effect immediately."** All three false.
//
// WHY. `deriveStatusDot` falls through to `status?.configured ? 'connected'
// : 'no-key'`, and `configured` is `Boolean(process.env[name]?.trim())` — pure
// PRESENCE. The same presence-vs-works confusion as BUG-143's own guard, one
// layer up in the UI: the selection logic got fixed and the DISPLAY was left
// lying. On this screen that costs the most, because someone who reads
// "Connected" stops looking for the problem — which is precisely how the
// founder ended up running on a Cloudflare key Cloudflare rejects.
//
// The fix feeds the save's own validation result into the SAME state the "Test
// key" button already writes, so there is one display path with one meaning.
// This file pins that mapping. It is a pure function on purpose: this repo
// cannot assert on component render output (BUG-140), and both render sites
// read `STATUS_DOT_LABEL[deriveStatusDot(...)]`, so pinning the function pins
// the words on screen.
import { describe, expect, it } from 'vitest'
import { deriveStatusDot, demotionNotice, STATUS_DOT_LABEL } from '../ApiKeysSection'

const saved = { configured: true, hint: '••••' }
const absent = { configured: false, hint: null }

describe('the API key status dot never claims more than it knows', () => {
  it('THE FIELD CASE: a saved key whose validation FAILED does not read "Connected"', () => {
    const dot = deriveStatusDot(saved, { ok: false, message: 'Your key was rejected.' })
    expect(dot).toBe('invalid')
    expect(STATUS_DOT_LABEL[dot]).toBe('Key invalid')
    expect(STATUS_DOT_LABEL[dot]).not.toBe('Connected')
  })

  it('a rate-limit is told apart from a bad key — different fix, different word', () => {
    const dot = deriveStatusDot(saved, { ok: false, message: 'Rate limited, try again shortly.' })
    expect(dot).toBe('rate-limited')
    expect(STATUS_DOT_LABEL[dot]).toBe('Rate limited')
  })

  it('a key that DID validate reads "Connected", so the word still means something', () => {
    expect(STATUS_DOT_LABEL[deriveStatusDot(saved, { ok: true, message: 'ok' })]).toBe('Connected')
  })

  it('no key at all reads "No key"', () => {
    expect(STATUS_DOT_LABEL[deriveStatusDot(absent, null)]).toBe('No key')
  })

  // THE REMAINING LIE WAS FIXED, AND THIS IS THE SAYING-SO.
  //
  // The case that stood here asserted that a saved key with no verdict reads
  // "Connected", and carried an instruction: "this test going red means someone
  // fixed it, and they should delete this case and say so." It went red on
  // 2026-08-31 (BUG-146). Deleted, and said so.
  //
  // What replaced it is the opposite guarantee. Presence is no longer allowed
  // to stand in for health anywhere on this screen.
  it('BUG-146: a saved key with NO verdict reads "Not checked", never "Connected"', () => {
    // This is the state EVERY card is in on a fresh launch — verdicts live in
    // React state and are not persisted — so it is the common case, not an edge
    // one. It is also the exact state the founder was in when a green
    // "Connected" told them a rejected Cloudflare token was fine.
    const dot = deriveStatusDot(saved, null)
    expect(dot).toBe('unchecked')
    expect(STATUS_DOT_LABEL[dot]).toBe('Not checked')
    expect(STATUS_DOT_LABEL[dot]).not.toBe('Connected')
  })

  it('"Not checked" and "No key" are different words for different states', () => {
    // They must not collapse into one another: "we have no key" and "we have a
    // key we have not checked" call for different actions from the user, and
    // rendering them identically would just move the lie rather than remove it.
    expect(deriveStatusDot(saved, null)).not.toBe(deriveStatusDot(absent, null))
    expect(STATUS_DOT_LABEL[deriveStatusDot(absent, null)]).toBe('No key')
  })

  it('"Connected" is now reachable ONLY through a verdict that said ok', () => {
    // The property that makes the word mean something. Enumerated rather than
    // argued: of every input shape this function accepts, exactly the ok-verdict
    // one may produce "Connected".
    const inputs = [
      deriveStatusDot(saved, null),
      deriveStatusDot(absent, null),
      deriveStatusDot(saved, { ok: false, message: 'Your key was rejected.' }),
      deriveStatusDot(saved, { ok: false, message: 'Rate limited, try again shortly.' }),
      deriveStatusDot(absent, { ok: false, message: 'Your key was rejected.' })
    ]
    expect(inputs.filter((d) => d === 'connected')).toEqual([])
    expect(deriveStatusDot(saved, { ok: true, message: 'Key works.' })).toBe('connected')
  })
})

describe('BUG-148: the demotion says so, without interrupting', () => {
  it('says nothing at all for a provider in good standing', () => {
    // The common case, and the one that must stay silent: a notice that
    // appears when nothing is wrong is a notice people learn to ignore.
    expect(demotionNotice(undefined)).toBeNull()
  })

  it('names what happened, that the SETTING is untouched, and what clears it', () => {
    const msg = demotionNotice(Date.UTC(2026, 7, 31, 12, 34))
    expect(msg).toBeTruthy()
    // The founder's framing: we are not overriding the choice, we are
    // declining to spend the first attempt on a rejected credential. If this
    // sentence goes, the UI has started making a silent change again.
    expect(msg).toMatch(/rejected your key/i)
    expect(msg).toMatch(/setting has not changed/i)
    expect(msg).toMatch(/Test or re-save/i)
  })

  it('is a PURE function of its input — the same state always renders the same words', () => {
    // Not a style point. The first version formatted "5 min ago", which needs
    // Date.now() at render time: an impure call during render, flagged by the
    // React rules lint, and text that can disagree with itself between two
    // renders of identical state. Calling it twice must give one answer.
    const at = Date.UTC(2026, 7, 31, 9, 5)
    expect(demotionNotice(at)).toBe(demotionNotice(at))
  })
})
