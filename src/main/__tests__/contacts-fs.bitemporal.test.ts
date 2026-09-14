// M39 §8 — bi-temporal facts through the REAL contact store, against a scratch
// dir: the write path, the tombstone, the import merge (including the sequence
// where an older build overwrote the cloud row), and the two things that must
// NOT happen — a rewrite on a pull that brings nothing new (BUG-279's loop) and
// a patch from the renderer planting history.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contactBackupPayload,
  createContact,
  deleteContact,
  getContact,
  importContact,
  listContacts,
  updateContact,
  type Contact
} from '../contacts-fs'
import { currentFact } from '../contact-facts'

const JUL = '2026-07-14T10:00:00.000Z'
let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-bitemporal-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const onDisk = async (id: string): Promise<Contact> =>
  JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as Contact

async function make(fields: Record<string, unknown> = {}): Promise<Contact> {
  const c = await createContact(dir, { name: 'Dana Reyes', ...fields })
  if (!c) throw new Error('setup')
  return c
}

describe('the write path', () => {
  it('a typed edit appends one user/approx fact dated now, and an unchanged save appends nothing', async () => {
    const c = await make()
    expect(c.factHistory).toBeUndefined() // nothing dated yet: no history, no rewrite of the shape
    const before = Date.now()
    const u1 = await updateContact(dir, c.id, { budgetIndication: '$50k' })
    const fact = currentFact(u1?.factHistory, 'budgetIndication')
    expect(fact).toMatchObject({ value: '$50k', source: 'user', validFromSource: 'approx' })
    expect(Date.parse(fact!.validFrom)).toBeGreaterThanOrEqual(before)
    // The Contact form sends every field on every save.
    const u2 = await updateContact(dir, c.id, { budgetIndication: '$50k', name: 'Dana Reyes' })
    expect(u2?.factHistory).toHaveLength(1)
    expect((await onDisk(c.id)).factHistory).toHaveLength(1)
  })

  it('a value present at creation begins the history', async () => {
    const c = await make({ timeline: 'Q4' })
    expect(currentFact(c.factHistory, 'timeline')?.value).toBe('Q4')
    expect((await onDisk(c.id)).factHistory).toHaveLength(1)
  })

  it('an accepted AI fact is dated to its CALL, not to the click', async () => {
    const c = await make()
    const u = await updateContact(
      dir,
      c.id,
      { budgetIndication: '$50k' },
      { callId: 'call-jul', at: JUL }
    )
    expect(currentFact(u?.factHistory, 'budgetIndication')).toMatchObject({
      value: '$50k',
      validFrom: JUL,
      validFromSource: 'call',
      source: 'ai-accepted',
      callId: 'call-jul'
    })
  })

  it('the current value is the latest validFrom, not the latest write', async () => {
    const c = await make()
    await updateContact(dir, c.id, { budgetIndication: 'typed today' })
    const u = await updateContact(
      dir,
      c.id,
      { budgetIndication: 'from July' },
      { callId: 'call-jul', at: JUL }
    )
    expect(u?.budgetIndication).toBe('typed today') // the older suggestion did not overwrite it
    expect((await onDisk(c.id)).budgetIndication).toBe('typed today')
    expect(u?.factHistory?.find((f) => f.value === 'from July')?.validUntil).toBeDefined()
  })

  it('an UNDATED field records no fact', async () => {
    const c = await make()
    const u = await updateContact(dir, c.id, { industry: 'Fintech', email: 'd@example.com' })
    expect(u?.industry).toBe('Fintech')
    expect(u?.factHistory).toBeUndefined()
  })

  it('clearing a field redacts every prior value and removes the flat field', async () => {
    const c = await make()
    await updateContact(dir, c.id, { personalNotes: 'neighbour back at 6' })
    await updateContact(dir, c.id, { personalNotes: 'has two kids' })
    const u = await updateContact(dir, c.id, { personalNotes: null })
    expect(u?.personalNotes).toBeUndefined()
    const raw = await readFile(join(dir, `${c.id}.json`), 'utf8')
    expect(raw).not.toContain('neighbour')
    expect(raw).not.toContain('two kids')
    expect(u?.factHistory?.filter((f) => f.field === 'personalNotes')).toHaveLength(3)
    expect(u?.factHistory?.every((f) => f.redacted && f.value === null)).toBe(true)
    // And it syncs redacted: the payload carries no words either.
    expect(JSON.stringify(contactBackupPayload(u!))).not.toContain('neighbour')
  })

  it('a patch carrying factHistory is ignored — the store writes history, the renderer does not', async () => {
    const c = await make()
    const planted = [
      {
        id: 'p',
        field: 'email',
        value: 'x',
        validFrom: JUL,
        validFromSource: 'call',
        recordedAt: JUL,
        source: 'user'
      }
    ]
    const u = await updateContact(dir, c.id, { factHistory: planted } as never)
    expect(u?.factHistory).toBeUndefined()
    expect((await onDisk(c.id)).factHistory).toBeUndefined()
  })

  it('a tombstone keeps no history', async () => {
    const c = await make({ budgetIndication: '$50k' })
    expect(c.factHistory).toHaveLength(1)
    expect((await deleteContact(dir, c.id)).ok).toBe(true)
    const t = await onDisk(c.id)
    expect(t.deleted).toBe(true)
    expect(t.factHistory).toBeUndefined()
    expect(JSON.stringify(t)).not.toContain('$50k')
    // and a tombstone read back through the sanitizer stays history-free
    expect((await listContacts(dir, { includeDeleted: true }))[0]?.factHistory).toBeUndefined()
  })

  it('history survives a read → unrelated write round trip (the BUG-095 shape)', async () => {
    const c = await make()
    await updateContact(dir, c.id, { timeline: 'Q4' })
    await updateContact(dir, c.id, { email: 'd@example.com' })
    expect((await getContact(dir, c.id))?.factHistory).toHaveLength(1)
  })
})

describe('the import merge', () => {
  /** What the other machine's row looks like after a push: the backup payload. */
  const row = (c: Contact, over: Partial<Contact> = {}): Record<string, unknown> => ({
    ...contactBackupPayload(c),
    ...over
  })
  const later = (iso: string, ms = 60_000): string => new Date(Date.parse(iso) + ms).toISOString()

  it('a pull of a record whose history this machine already holds rewrites NOTHING', async () => {
    const c = await make()
    const mine = (await updateContact(dir, c.id, { timeline: 'Q4' }))!
    const before = await readFile(join(dir, `${c.id}.json`), 'utf8')
    // The same record, round-tripped through the server (BUG-279: same updatedAt).
    const r = await importContact(dir, row(mine), { onlyIfNewer: true })
    expect(r).toBeNull()
    expect(await readFile(join(dir, `${c.id}.json`), 'utf8')).toBe(before)
  })

  it('a newer row with IDENTICAL history imports without bumping updatedAt', async () => {
    const c = await make()
    const mine = (await updateContact(dir, c.id, { timeline: 'Q4' }))!
    const theirs = row(mine, { updatedAt: later(mine.updatedAt), email: 'd@example.com' })
    const r = await importContact(dir, theirs, { onlyIfNewer: true })
    expect(r?.email).toBe('d@example.com')
    expect(r?.updatedAt).toBe(theirs.updatedAt) // not bumped: nothing was restored
    expect(r?.factHistory).toHaveLength(1)
  })

  it('two-device union: a fact only this machine holds is kept, and updatedAt is bumped so the next push wins', async () => {
    const c = await make()
    const mine = (await updateContact(dir, c.id, { timeline: 'Q4' }))!
    // The other machine added a DIFFERENT fact on a copy that lacks ours.
    const theirsHistory = [
      {
        id: 'other-1',
        field: 'budgetIndication',
        value: '$50k',
        validFrom: JUL,
        validFromSource: 'call',
        recordedAt: JUL,
        source: 'ai-accepted'
      }
    ]
    const theirs = row(mine, {
      updatedAt: later(mine.updatedAt),
      factHistory: theirsHistory as never,
      budgetIndication: '$50k'
    })
    const r = await importContact(dir, theirs, { onlyIfNewer: true })
    expect(r?.factHistory?.map((f) => f.field).sort()).toEqual(['budgetIndication', 'timeline'])
    expect(r?.timeline).toBe('Q4')
    expect(r?.budgetIndication).toBe('$50k')
    expect(Date.parse(r!.updatedAt)).toBeGreaterThan(Date.parse(theirs.updatedAt as string))
    // ...and the bumped record's payload now carries BOTH facts for the push.
    expect((contactBackupPayload(r!).factHistory as unknown[]).length).toBe(2)
  })

  it('an OLDER build overwrote the cloud row: history is restored and its flat edit is kept AND dated', async () => {
    const c = await make()
    const mine = (await updateContact(dir, c.id, { timeline: 'Q4', budgetIndication: '$50k' }))!
    // The old build strips factHistory on read, edits the timeline, pushes — newer, history-less.
    const { factHistory: _h, ...stripped } = row(mine) as Record<string, unknown> & {
      factHistory?: unknown
    }
    void _h
    const theirs = { ...stripped, updatedAt: later(mine.updatedAt), timeline: 'Q1' }
    const r = await importContact(dir, theirs, { onlyIfNewer: true })
    expect(r?.timeline).toBe('Q1') // the old build's edit is NOT reverted
    expect(currentFact(r?.factHistory, 'timeline')).toMatchObject({
      value: 'Q1',
      source: 'import',
      validFrom: theirs.updatedAt
    })
    expect(r?.factHistory?.filter((f) => f.field === 'timeline')).toHaveLength(2) // Q4 closed, Q1 open
    expect(currentFact(r?.factHistory, 'budgetIndication')?.value).toBe('$50k') // untouched value: no import fact
    expect(r?.factHistory?.filter((f) => f.field === 'budgetIndication')).toHaveLength(1)
    expect(Date.parse(r!.updatedAt)).toBeGreaterThan(Date.parse(theirs.updatedAt)) // restored → bump
  })

  it('an older build CLEARED a dated field: the clearing is honoured and redacts', async () => {
    const c = await make()
    const mine = (await updateContact(dir, c.id, { personalNotes: 'neighbour back at 6' }))!
    const { factHistory: _h, personalNotes: _p, ...stripped } = row(mine) as Record<string, unknown>
    void _h
    void _p
    const r = await importContact(
      dir,
      { ...stripped, updatedAt: later(mine.updatedAt) },
      { onlyIfNewer: true }
    )
    expect(r?.personalNotes).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('neighbour')
  })

  it('a row with values and NO history — the 29 undated values — imports with every flat value intact', async () => {
    const theirs = {
      id: 'pre-release-1',
      name: 'Old Contact',
      budgetIndication: 'approved',
      timeline: 'Q4',
      personalNotes: 'cycles',
      createdAt: JUL,
      updatedAt: JUL
    }
    const r = await importContact(dir, theirs, { onlyIfNewer: true })
    expect(r).toMatchObject({
      budgetIndication: 'approved',
      timeline: 'Q4',
      personalNotes: 'cycles'
    })
    expect(r?.factHistory).toBeUndefined()
    // and a later pull of the same row still touches nothing
    const before = await readFile(join(dir, 'pre-release-1.json'), 'utf8')
    expect(await importContact(dir, theirs, { onlyIfNewer: true })).toBeNull()
    expect(await readFile(join(dir, 'pre-release-1.json'), 'utf8')).toBe(before)
  })

  it('redaction wins across devices: the cloud copy still holding the words comes back redacted', async () => {
    const c = await make()
    const withWords = (await updateContact(dir, c.id, { personalNotes: 'neighbour back at 6' }))!
    const theirs = row(withWords, { updatedAt: later(withWords.updatedAt, 5_000) }) // their copy, unchanged, slightly newer
    await updateContact(dir, c.id, { personalNotes: null }) // we clear it here, after their stamp
    const r = await importContact(
      dir,
      { ...theirs, updatedAt: later(withWords.updatedAt, 10 * 60_000) },
      { onlyIfNewer: true }
    )
    expect(r?.personalNotes).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('neighbour')
    expect(JSON.stringify(await onDisk(c.id))).not.toContain('neighbour')
  })
})
