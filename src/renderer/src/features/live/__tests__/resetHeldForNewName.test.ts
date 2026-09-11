// M39 — the rule that decides whether a rep's mid-call identity answer
// survives, tested as BEHAVIOUR rather than pinned as source text.
//
// The answer used to live in a `useRef` inside `useLiveIdentityOffer`, which
// lives in `LiveView`, which unmounts on every screen navigation. Moving it up
// to `LiveCallProvider` fixes the lifetime and creates a new hazard in the same
// breath: the reset effect re-runs on every REMOUNT, so a rule keyed only on
// "the name is non-null" would wipe, on the way back from Pipeline, exactly the
// answer the hoist was meant to preserve. The bug would have moved rather than
// been fixed, and no test would have said so.
//
// Three cases, each one a mistake that has actually been made here once.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetHeldForNewName } from '../useLiveIdentityOffer'
import type { LiveIdentityHeld } from '../useLiveCall'

const held = (over: Partial<LiveIdentityHeld> = {}): { current: LiveIdentityHeld } => ({
  current: { decision: null, dismissed: false, forName: null, ...over }
})

const answered = (name: string, forName = name): { current: LiveIdentityHeld } =>
  held({ decision: { kind: 'link', contactId: 'c1', contactName: name }, forName })

describe('resetHeldForNewName', () => {
  it('keeps the answer when the spoken name is CLEARED mid-call', () => {
    // useLiveCues nulls buyerName on its own reset, reachable mid-call when
    // the rep switches cues off. Wiping there would leave applyToSavedCall
    // with nothing to apply — the silent no-op the whole design prevents,
    // reached from the other end.
    const h = answered('Harvey')
    expect(resetHeldForNewName(h, null)).toBe(false)
    expect(h.current.decision).toEqual({ kind: 'link', contactId: 'c1', contactName: 'Harvey' })
    expect(h.current.forName).toBe('Harvey')
  })

  it('keeps the answer when the SAME name is heard again (a remount)', () => {
    const h = answered('Harvey')
    expect(resetHeldForNewName(h, 'Harvey')).toBe(false)
    expect(h.current.decision).not.toBeNull()
  })

  it('keeps a DISMISSAL across a remount too, so the chip does not re-ask', () => {
    const h = held({ dismissed: true, forName: 'Harvey' })
    expect(resetHeldForNewName(h, 'Harvey')).toBe(false)
    expect(h.current.dismissed).toBe(true)
  })

  it('clears everything when a DIFFERENT name is heard', () => {
    // A new conversation. Carrying the old answer would link a later buyer to
    // an earlier one's contact.
    const h = answered('Harvey')
    expect(resetHeldForNewName(h, 'Priya')).toBe(true)
    expect(h.current).toEqual({ decision: null, dismissed: false, forName: 'Priya' })
  })

  it('claims the first name heard on a fresh call', () => {
    const h = held()
    expect(resetHeldForNewName(h, 'Harvey')).toBe(true)
    expect(h.current.forName).toBe('Harvey')
  })

  it('is exact about names — a different capitalisation is a different name', () => {
    // Deliberate and stated rather than silently case-insensitive: this value
    // comes from the model on one call and is compared to itself within that
    // call, so the only way it differs is that the model said something
    // different — which IS a new answer to ask about.
    const h = answered('Harvey')
    expect(resetHeldForNewName(h, 'harvey')).toBe(true)
  })

  it('the reset is not sticky — re-heard once, kept thereafter', () => {
    const h = held()
    expect(resetHeldForNewName(h, 'Priya')).toBe(true)
    expect(resetHeldForNewName(h, 'Priya')).toBe(false)
    expect(resetHeldForNewName(h, 'Priya')).toBe(false)
  })

  it('asks again on the NEXT call with the same buyer, once the call boundary clears it', () => {
    // THE REGRESSION THE FIRST LIFETIME FIX SHIPPED. Two calls with Harvey in
    // one session: the rep dismisses on call one, and `forName` is 'Harvey'.
    // Call two re-detects 'Harvey', the guard says "same name, keep it", and
    // the chip never asks. The guard written to survive a REMOUNT also
    // survived a new CALL.
    //
    // The state does not belong to a name; it belongs to a name WITHIN a call.
    // `LiveCallProvider.onSaved` is where the call ends, so that is where it
    // is cleared — modelled here as the reset it performs.
    const h = answered('Harvey')
    h.current.dismissed = true

    // …call one saves. The provider clears the held answer.
    h.current = { decision: null, dismissed: false, forName: null }

    // …call two, same buyer.
    expect(resetHeldForNewName(h, 'Harvey')).toBe(true)
    expect(h.current.dismissed).toBe(false)
    expect(h.current.decision).toBeNull()
  })
})

describe('the call boundary is where held identity state dies', () => {
  it('the provider clears it inside onSaved, AFTER handing off to the view', () => {
    // Order is load-bearing: handleSaved calls applyToSavedCall, which reads
    // the decision and nulls it synchronously before its first await.
    // Clearing first would discard the answer a moment before applying it.
    const src = readFileSync(join(__dirname, '..', 'LiveCallProvider.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const body = src.match(/const onSaved = useCallback\(\(callId: string\) => \{[\s\S]*?\}, \[\]\)/)
    expect(body, 'onSaved must still exist').not.toBeNull()
    const handoff = body![0].indexOf('onSavedRef.current?.(callId)')
    const clear = body![0].indexOf('liveIdentity.current = {')
    expect(handoff, 'the handoff must be present').toBeGreaterThan(-1)
    expect(clear, 'the clear must be present').toBeGreaterThan(-1)
    expect(clear).toBeGreaterThan(handoff)
  })
})
