// M32 Stage 2 — the outcome reason's write path.
//
// Small on purpose: the field is one optional string. What earns tests is the
// EMPTY handling, because the whole design rests on "there was no reason" and
// "not answered" staying different claims — the renderer sends null for an
// empty save precisely so the record never holds '' pretending to be a reason.
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeal, getDeal, updateDeal, importDeal } from '../deals-fs'

describe('outcomeReason on the deal record', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-reason-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function makeDeal(): Promise<string> {
    const deal = await createDeal(dir, {
      title: 'Acme',
      contactId: 'contact-1',
      stageId: 'st-won'
    })
    return deal!.id
  }

  it('sets and reads back', async () => {
    const id = await makeDeal()
    await updateDeal(dir, id, { outcomeReason: 'got the technical lead early' })
    expect((await getDeal(dir, id))?.outcomeReason).toBe('got the technical lead early')
  })

  it('null CLEARS — and the cleared record holds NO key, not an empty string', async () => {
    const id = await makeDeal()
    await updateDeal(dir, id, { outcomeReason: 'a reason' })
    await updateDeal(dir, id, { outcomeReason: null })
    const deal = await getDeal(dir, id)
    expect(deal?.outcomeReason, 'cleared reason still present').toBeUndefined()
    // The claim-level assertion, made against the DISK, because that is where
    // the claim lives: '' must be unrepresentable in the stored record. (The
    // first draft asserted hasOwnProperty on the value getDeal returns — and
    // failed, correctly: sanitizeDealRecord lists every field, so the key
    // exists in memory with value undefined. The in-memory shape was a proxy;
    // the file is the thing.)
    const rawFile = await readFile(join(dir, id + '.json'), 'utf8')
    expect(rawFile.includes('outcomeReason'), 'the cleared key survived on disk').toBe(false)
  })

  it("a whitespace-only 'reason' is treated as none", async () => {
    const id = await makeDeal()
    await updateDeal(dir, id, { outcomeReason: '   \n  ' })
    expect((await getDeal(dir, id))?.outcomeReason).toBeUndefined()
  })

  it('an absent key on update leaves the existing reason alone', async () => {
    // The other half of the null-clears contract, same as dealId's: absent
    // preserves. Without this, every unrelated edit (a title fix, a value
    // change) would wipe the reason.
    const id = await makeDeal()
    await updateDeal(dir, id, { outcomeReason: 'kept' })
    await updateDeal(dir, id, { title: 'Acme Robotics' })
    expect((await getDeal(dir, id))?.outcomeReason).toBe('kept')
  })

  it('caps at 500 characters', async () => {
    const id = await makeDeal()
    await updateDeal(dir, id, { outcomeReason: 'x'.repeat(2000) })
    expect((await getDeal(dir, id))?.outcomeReason).toHaveLength(500)
  })

  it('survives the import path — a synced deal keeps its reason', async () => {
    const id = await makeDeal()
    await updateDeal(dir, id, { outcomeReason: 'price, and budget went elsewhere' })
    const deal = await getDeal(dir, id)
    // Round-trip through the sanitizer the way a cloud pull does.
    const imported = await importDeal(dir, { ...deal })
    expect(imported?.outcomeReason).toBe('price, and budget went elsewhere')
    expect((await getDeal(dir, id))?.outcomeReason).toBe('price, and budget went elsewhere')
  })
})
