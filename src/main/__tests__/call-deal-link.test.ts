// M32 Stage 2 — the call→deal link, and specifically the three-way sync
// contract that decides whether it survives contact with a cloud row.
//
// WHY THIS FILE IS MOSTLY ABOUT SYNC RATHER THAN ABOUT LINKING. Storing a
// `dealId` is trivial. What is not trivial is what happens when a row arrives
// from a build that has never heard of the field — which is every build before
// this one, and will be every other machine on the founder's account until they
// all update.
//
// The failure being prevented is silent and total: if an absent `dealId` read
// as "unlink", one pull from an older install would detach every call from its
// deal, the outcome analysis would lose its entire join, and NOTHING would go
// red — the calls are all still there, the deals are all still there, only the
// edges are gone. That is BUG-126's shape exactly (a cloud pull teleporting one
// machine's state onto another), and it is why absent and null must mean
// different things.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCall, getCall, importCall, callBackupPayload, setCallDeal } from '../calls-fs'

describe('the call→deal link survives sync the way the contact link does', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-dealid-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function makeLinkedCall(): Promise<string> {
    const s = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [{ speaker: 0, text: 'hello', startMs: 0, endMs: 500 }]
    } as never)
    const id = (s as { id: string }).id
    const call = await getCall(dir, id)
    await importCall(dir, { ...callBackupPayload(call!), dealId: 'deal-alpha' })
    return id
  }

  it('links a call to a deal', async () => {
    const id = await makeLinkedCall()
    expect((await getCall(dir, id))?.dealId).toBe('deal-alpha')
  })

  it('THE ONE THAT MATTERS: an ABSENT dealId preserves the link, it does not unlink', async () => {
    // A row from any build older than M32 Stage 2. If this ever regresses, one
    // sync from an un-updated machine silently strips the join off every call.
    const id = await makeLinkedCall()
    const call = await getCall(dir, id)
    const oldStylePayload = { ...callBackupPayload(call!) } as Record<string, unknown>
    delete oldStylePayload.dealId

    await importCall(dir, oldStylePayload)
    expect(
      (await getCall(dir, id))?.dealId,
      'an absent dealId was read as "unlink" — a pre-Stage-2 sync would wipe every deal link'
    ).toBe('deal-alpha')
  })

  it('an explicit null DOES unlink — absent and null are different answers', async () => {
    // The other half. Without this, "absent preserves" could be implemented as
    // "nothing ever unlinks", and a deliberate unlink on another machine would
    // never propagate. Both halves are needed for the pair to mean anything.
    const id = await makeLinkedCall()
    const call = await getCall(dir, id)
    await importCall(dir, { ...callBackupPayload(call!), dealId: null })
    expect((await getCall(dir, id))?.dealId).toBeUndefined()
  })

  it('a malformed dealId is rejected rather than stored', async () => {
    const id = await makeLinkedCall()
    const call = await getCall(dir, id)
    await importCall(dir, { ...callBackupPayload(call!), dealId: '../../etc/passwd' })
    // Falls back to the local value rather than writing a path-shaped id that
    // would later be joined against, or interpolated into, a filename.
    expect((await getCall(dir, id))?.dealId).toBe('deal-alpha')
  })

  it('the backup payload actually CARRIES dealId', async () => {
    // The control for all of the above. Every merge test here passes vacuously
    // if the field is never sent — `v.dealId` would simply always be absent and
    // "preserve" would be the only branch ever taken. This is the assertion
    // that makes the others mean something.
    const id = await makeLinkedCall()
    const payload = callBackupPayload((await getCall(dir, id))!) as Record<string, unknown>
    expect(Object.keys(payload), 'dealId is not in the synced payload').toContain('dealId')
    expect(payload.dealId).toBe('deal-alpha')
  })

  it('a call with no deal sends null, not an absent field', async () => {
    const s = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      segments: [{ speaker: 0, text: 'x', startMs: 0, endMs: 10 }]
    } as never)
    const call = await getCall(dir, (s as { id: string }).id)
    const payload = callBackupPayload(call!) as Record<string, unknown>
    expect(payload.dealId).toBeNull()
  })
})

describe('setCallDeal — the write path both linking surfaces share', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-setcalldeal-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function newCall(): Promise<string> {
    const s = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      segments: [{ speaker: 0, text: 'x', startMs: 0, endMs: 10 }]
    } as never)
    return (s as { id: string }).id
  }

  it('sets the link', async () => {
    const id = await newCall()
    await setCallDeal(dir, id, 'deal-alpha')
    expect((await getCall(dir, id))?.dealId).toBe('deal-alpha')
  })

  it('null CLEARS the link — the Unlink button, and the backfill undo', async () => {
    const id = await newCall()
    await setCallDeal(dir, id, 'deal-alpha')
    await setCallDeal(dir, id, null)
    expect((await getCall(dir, id))?.dealId).toBeUndefined()
  })

  it('a malformed id is a NO-OP that keeps the existing link', async () => {
    // The three-way shape, and the branch that matters. Failing CLOSED here
    // means the link is missing, which is visible on screen. Failing open
    // means a path-shaped or object-shaped id lands in a field that is later
    // joined against and fed into the outcome analysis — invisible, and wrong.
    const id = await newCall()
    await setCallDeal(dir, id, 'deal-alpha')
    for (const bad of ['../../etc/passwd', '', 'has spaces', {}, 42, ['deal-alpha']]) {
      await setCallDeal(dir, id, bad)
      expect((await getCall(dir, id))?.dealId, `${JSON.stringify(bad)} was accepted`).toBe(
        'deal-alpha'
      )
    }
  })

  it('...and a malformed id on an UNLINKED call leaves it unlinked', async () => {
    // The other half of the same branch. Without this, "no-op" could be
    // implemented as "always keep whatever was there", and the previous test
    // would pass while a garbage id silently became the link on a fresh call.
    const id = await newCall()
    await setCallDeal(dir, id, '../../etc/passwd')
    expect((await getCall(dir, id))?.dealId).toBeUndefined()
  })

  it('bumps updatedAt, so a linked call actually syncs', async () => {
    // Cloud sync is newest-wins on updatedAt. A link written without touching
    // it would be correct locally and never leave the machine — the deal would
    // lose its calls on every other device, silently.
    const id = await newCall()
    const before = (await getCall(dir, id))!.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await setCallDeal(dir, id, 'deal-alpha')
    const after = (await getCall(dir, id))!.updatedAt
    expect(Date.parse(after), 'updatedAt did not move — the link would never sync').toBeGreaterThan(
      Date.parse(before)
    )
  })

  it('returns null for a call that does not exist', async () => {
    expect(await setCallDeal(dir, 'no-such-call', 'deal-alpha')).toBeNull()
  })
})
