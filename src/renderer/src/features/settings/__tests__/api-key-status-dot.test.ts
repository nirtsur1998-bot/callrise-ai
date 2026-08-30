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
import { deriveStatusDot, STATUS_DOT_LABEL } from '../ApiKeysSection'

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

  it('THE REMAINING LIE, pinned so it is a known gap rather than a surprise', () => {
    // With no validation result at all — a key restored from disk at startup,
    // or one of the two cards this fix does not reach (DEEPGRAM_API_KEY and
    // CLOUDFLARE_ACCOUNT_ID resolve to no providerId, so neither is ever
    // validated) — the dot STILL falls back to presence and says "Connected".
    //
    // That is the M16-era limitation the source comment already admits. It is
    // asserted here rather than left implicit: this test going red means
    // someone fixed it, and they should delete this case and say so.
    expect(STATUS_DOT_LABEL[deriveStatusDot(saved, null)]).toBe('Connected')
  })
})
