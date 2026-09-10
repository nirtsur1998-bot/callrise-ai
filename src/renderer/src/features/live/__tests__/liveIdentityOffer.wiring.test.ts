// @vitest-environment node
//
// M39 Stage 2 — does LiveView actually MOUNT the chip, with the right inputs,
// behind the right gates, and apply the answer at save?
//
// WHY THIS IS A SOURCE-READING TEST AND NOT A RENDER. The chip only appears
// during a call; a call needs a transcription key, and the sandbox profile has
// none (the Home screen says so in as many words). There is no render harness
// in this repo either — no testing-library, so no way to mount LiveView with
// fake hooks without inventing one. That leaves two honest options: claim the
// wiring from a reading, or pin it. This pins it.
//
// It is a WEAKER instrument than a render and is written to be worth having
// anyway: every assertion below is a line that, if it silently changed, would
// turn the feature off with no test failing anywhere else in the suite. The
// unit tests cover what the offer DECIDES; this covers that anything asks it.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIVE = join(__dirname, '..')
const src = readFileSync(join(LIVE, 'LiveView.tsx'), 'utf8')

describe('M39 — LiveView mounts the live identity chip', () => {
  it('renders the chip component', () => {
    expect(src).toContain('<LiveIdentityOfferChip')
    expect(src).toContain("import { LiveIdentityOfferChip } from './LiveIdentityOfferChip'")
  })

  it('feeds it the live buyer name and the MEETING contact, not a call contact', () => {
    // There is no call record mid-call, so `currentMeeting.contactId` is the
    // only link that exists. A future edit that "corrects" this to a call
    // field would compile, render, and always be null.
    const call = src.match(/useLiveIdentityOffer\(\{[\s\S]*?\}\)/)
    expect(call, 'LiveView must call useLiveIdentityOffer').not.toBeNull()
    expect(call?.[0]).toContain('spokenName: buyerName')
    expect(call?.[0]).toContain('linkedContactId: currentMeeting?.contactId')
  })

  it('gates it on the contact-intelligence mode AND consent', () => {
    const call = src.match(/useLiveIdentityOffer\(\{[\s\S]*?\}\)/)
    expect(call?.[0]).toContain("contactIntelligenceMode !== 'off'")
    expect(call?.[0]).toContain('consent.canRecord')
  })

  it('hides it in Quiet mode', () => {
    // Quiet's contract is that nothing new asks to be READ mid-call. The
    // question keeps — the Call Detail page asks it again after the save.
    expect(src).toMatch(/\{!quiet && identityOffer\.offer && \(/)
  })

  it('applies the rep’s answer when the call is saved', () => {
    // THE LINE THE WHOLE DESIGN RESTS ON. Without it every button on the chip
    // is decoration: the decision is held in a ref and nothing ever writes it.
    expect(src).toContain('identityOfferApplyRef.current(callId)')
    // …and inside handleSaved, not somewhere that never runs. Checked by
    // locating the call within the handler's own body rather than anywhere in
    // the file.
    const handler = src.match(/const handleSaved = useCallback\([\s\S]*?\n  \)\n/)
    expect(handler, 'handleSaved must still exist').not.toBeNull()
    expect(handler?.[0]).toContain('identityOfferApplyRef.current(callId)')
  })

  it('keeps the ref bridge in sync', () => {
    expect(src).toContain('identityOfferApplyRef.current = identityOffer.applyToSavedCall')
  })

  it('never writes the calendar event from the identity offer', () => {
    // The meeting holds the mid-call link, so correcting it is the obvious
    // move — and for an Outlook or Google event that write is an EGRESS to a
    // real calendar. Three fictional events reached the founder's real Outlook
    // earlier in this milestone; this is the guard that would have to be
    // deleted for that class of mistake to happen from here.
    //
    // Comments are stripped first. The first version of this check flagged the
    // hook's own doc comment explaining why it does not write the calendar —
    // a guard that fails on the documentation of the thing it guards against
    // is noise, and it is the second time on this milestone I have written
    // one (see design-tokens-exist.test.ts).
    const hook = readFileSync(join(LIVE, 'useLiveIdentityOffer.ts'), 'utf8')
    const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toContain('setContact') // the stripper did not eat the file
    expect(code).not.toContain('events.update')
    expect(code).not.toContain('events.create')
    expect(code).not.toContain('api.events')
  })
})
