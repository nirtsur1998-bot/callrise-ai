import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContact, matchContactByName } from '../contacts-fs'

// matchContactByName backs Contact Intelligence's full-auto attach path
// (contact-intelligence-ipc.ts's maybeAutoCreateContact) — its whole job is
// to stop a repeat detection of the same buyer (no email, name-only signal)
// from silently minting a second, duplicate contact record.
//
// M39 rewrote it, because it had BUG-226's defect: `contacts.find(...)`, first
// wins on a tie, silently. Third instance of that shape in this project.
//
// THE SHAPES BELOW ARE THE FOUNDER'S REAL CORPUS, measured 2026-09-10 — 50
// contacts, 0 emails, 35 stored as a first name only, 8 first names shared by
// more than one contact (kevin ×3), 3 exact full-name collisions. These are not
// invented edge cases; each one is a state that exists on a real store today.
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-contacts-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('matchContactByName — the cases that already worked', () => {
  it('finds an exact match', async () => {
    const created = await createContact(dir, { name: 'Sarah Chen' })
    expect(created).not.toBeNull()
    const m = await matchContactByName(dir, 'Sarah Chen')
    expect(m.reason).toBe('matched')
    expect(m.contact?.id).toBe(created!.id)
  })

  it('matches case-insensitively and tolerates extra whitespace', async () => {
    const created = await createContact(dir, { name: 'Sarah Chen' })
    const m = await matchContactByName(dir, '  sarah   chen  ')
    expect(m.contact?.id).toBe(created!.id)
  })

  it('matches a bare first name to a first-name-only contact', async () => {
    // 37 of the 47 real self-introductions are exactly this: the buyer says
    // "Daniel", the contact is stored as "Daniel". This is the working path and
    // the tie-refusal below must not break it.
    const created = await createContact(dir, { name: 'Daniel' })
    const m = await matchContactByName(dir, 'Daniel')
    expect(m.reason).toBe('matched')
    expect(m.contact?.id).toBe(created!.id)
  })

  it('reports "none" when no contact has that name — the caller may create it', async () => {
    await createContact(dir, { name: 'Sarah Chen' })
    expect(await matchContactByName(dir, 'Priya Patel')).toEqual({ reason: 'none', contact: null })
  })

  it('reports "none" for an empty name', async () => {
    await createContact(dir, { name: 'Sarah Chen' })
    expect((await matchContactByName(dir, '   ')).reason).toBe('none')
  })
})

describe('matchContactByName — REFUSES on a tie rather than taking the first', () => {
  it('refuses when two contacts share the exact name', async () => {
    // Three of these exist on the real store right now.
    const a = await createContact(dir, { name: 'Kevin' })
    const b = await createContact(dir, { name: 'Kevin' })
    const m = await matchContactByName(dir, 'Kevin')
    expect(m.reason).toBe('ambiguous')
    expect(m.contact).toBeNull()
    expect(m.reason === 'ambiguous' && m.candidates.map((c) => c.id).sort()).toEqual(
      [a!.id, b!.id].sort()
    )
  })

  it('refuses on kevin ×3 — the real shape, not a two-way tie', async () => {
    await createContact(dir, { name: 'Kevin' })
    await createContact(dir, { name: 'kevin' }) // normalization must see these as one name
    await createContact(dir, { name: '  KEVIN ' })
    const m = await matchContactByName(dir, 'Kevin')
    expect(m.reason).toBe('ambiguous')
    expect(m.reason === 'ambiguous' && m.candidates.length).toBe(3)
  })

  it('ambiguous is NOT none — the difference is whether a contact gets created', async () => {
    // The distinction that matters at the call site: `none` means "create this
    // person", so collapsing a tie into `none` would mint a THIRD Kevin beside
    // the two it could not choose between.
    await createContact(dir, { name: 'Kevin' })
    await createContact(dir, { name: 'Kevin' })
    const tie = await matchContactByName(dir, 'Kevin')
    const miss = await matchContactByName(dir, 'Priya')
    expect(tie.reason).not.toBe(miss.reason)
  })
})

describe('matchContactByName — first+last spoken, first-name-only contact', () => {
  it('matches "Paul Trader" to a contact stored as "Paul"', async () => {
    // The rung 35 of 50 contacts need: the store holds a first name, the buyer
    // introduces themselves with both.
    const created = await createContact(dir, { name: 'Paul' })
    const m = await matchContactByName(dir, 'Paul Trader')
    expect(m.reason).toBe('matched')
    expect(m.reason === 'matched' && m.rule).toBe('first-name')
    expect(m.contact?.id).toBe(created!.id)
  })

  it('refuses when two contacts share that first name', async () => {
    await createContact(dir, { name: 'Paul' })
    await createContact(dir, { name: 'Paul' })
    expect((await matchContactByName(dir, 'Paul Trader')).reason).toBe('ambiguous')
  })

  it('never matches a DIFFERENT full name that shares a first name', async () => {
    // "Paul Trader" must not match "Paul Smith". That is not a looser match for
    // the same person, it is a guess about a different one — the exact failure
    // the original function's own comment said it was avoiding.
    await createContact(dir, { name: 'Paul Smith' })
    expect((await matchContactByName(dir, 'Paul Trader')).reason).toBe('none')
  })

  it('an exact match wins over a first-name match, and is not called ambiguous', async () => {
    // Both rules can fire on the same store. Rule order has to be stable, or a
    // contact stored under a full name would lose to a first-name-only one.
    const full = await createContact(dir, { name: 'Paul Trader' })
    await createContact(dir, { name: 'Paul' })
    const m = await matchContactByName(dir, 'Paul Trader')
    expect(m.reason).toBe('matched')
    expect(m.reason === 'matched' && m.rule).toBe('exact')
    expect(m.contact?.id).toBe(full!.id)
  })

  it('a lone first name does not reach the first-name rule', async () => {
    // Only rule 1 (exact) may match a single spoken word. Letting a lone
    // "Paul" fall through to rule 2 would change nothing here but would make
    // the two rules indistinguishable, and rule 2 is the looser one.
    await createContact(dir, { name: 'Paul Smith' })
    expect((await matchContactByName(dir, 'Paul')).reason).toBe('none')
  })
})
