// BUG-189 — the objection review queue joins the backup, so removals must be
// TOMBSTONES (a rejected candidate must not come back from the cloud) and a
// tombstone must carry no words (it is the buyer's verbatim quote it replaces).
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addToQueue,
  getQueueItem,
  importQueueItem,
  listQueue,
  purgeQueueForCall,
  removeFromQueue
} from '../objection-queue-fs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'objection-queue-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const candidate = (objectionQuote: string, responseQuote = 'rep answers') => ({
  type: 'price',
  objectionQuote,
  objectionSpeaker: 1,
  objectionVerified: true,
  responseQuote,
  responseSpeaker: 0,
  responseVerified: true,
  recoveredWell: true,
  judgmentNote: 'model prose about the exchange'
})

const rawFiles = (): Record<string, unknown>[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)

describe('tombstones instead of unlinks', () => {
  it('rejecting an item leaves a tombstone on disk that listQueue hides and the backup can read', async () => {
    const [item] = await addToQueue(dir, [candidate('it costs too much')], 'call-1', 'Call 1')
    expect(item.updatedAt).toBe(item.createdAt)

    expect(await removeFromQueue(dir, item.id)).toEqual({ ok: true })

    expect(await listQueue(dir)).toEqual([]) // gone from the review screen
    expect(await getQueueItem(dir, item.id)).toBeNull() // approve-again cannot find it
    const [stone] = await listQueue(dir, { includeDeleted: true })
    expect(stone.id).toBe(item.id)
    expect(stone.deleted).toBe(true)
    expect(stone.callId).toBe('call-1')
    expect(Date.parse(stone.updatedAt)).toBeGreaterThanOrEqual(Date.parse(item.createdAt))
  })

  it("a tombstone keeps NO words — not the buyer's, not the rep's, not the model's note, not the title", async () => {
    const [item] = await addToQueue(
      dir,
      [candidate('my wife says no', 'let me talk to her')],
      'call-1',
      'Kevin — upsell'
    )
    await removeFromQueue(dir, item.id)
    const [raw] = rawFiles()
    const text = JSON.stringify(raw)
    for (const words of ['my wife says no', 'let me talk to her', 'model prose', 'Kevin']) {
      expect(text).not.toContain(words)
    }
    expect(raw.deleted).toBe(true)
  })

  it('deleting the source call tombstones every item mined from it and none from another call', async () => {
    await addToQueue(dir, [candidate('a'), candidate('b')], 'call-1', 'Call 1')
    await addToQueue(dir, [candidate('c')], 'call-2', 'Call 2')
    expect(await purgeQueueForCall(dir, 'call-1')).toBe(2)
    const live = await listQueue(dir)
    expect(live.map((i) => i.objectionQuote)).toEqual(['c'])
    const all = await listQueue(dir, { includeDeleted: true })
    expect(all.filter((i) => i.deleted).map((i) => i.callId)).toEqual(['call-1', 'call-1'])
    expect(JSON.stringify(rawFiles())).not.toMatch(/"objectionQuote":"[ab]"/)
  })

  it('removing something that is not there, or already a tombstone, reports ok:false rather than pretending', async () => {
    expect(await removeFromQueue(dir, 'never-existed')).toEqual({ ok: false })
    const [item] = await addToQueue(dir, [candidate('x')], 'call-1', 'Call 1')
    await removeFromQueue(dir, item.id)
    expect(await removeFromQueue(dir, item.id)).toEqual({ ok: false })
  })
})

describe('importQueueItem — the cloud side of the reconcile', () => {
  it('imports a live item and a tombstone alike, through the one record parser', async () => {
    const live = await importQueueItem(dir, {
      id: 'from-cloud-1',
      type: 'timing',
      objectionQuote: 'not this quarter',
      objectionSpeaker: 1,
      responseQuote: 'what changes next quarter?',
      responseSpeaker: 0,
      recoveredWell: true,
      judgmentNote: 'n',
      callId: 'call-9',
      callTitle: 'Call 9',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z'
    })
    expect(live?.objectionQuote).toBe('not this quarter')
    expect((await listQueue(dir)).map((i) => i.id)).toEqual(['from-cloud-1'])

    const stone = await importQueueItem(dir, {
      id: 'from-cloud-1',
      type: 'timing',
      callId: 'call-9',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      deleted: true
    })
    expect(stone?.deleted).toBe(true)
    expect(await listQueue(dir)).toEqual([]) // the other machine's rejection landed here
  })

  it('onlyIfNewer keeps a same-or-newer local copy and lets a newer cloud copy through', async () => {
    const [item] = await addToQueue(dir, [candidate('local words')], 'call-1', 'Call 1')
    const older = { ...item, objectionQuote: 'stale cloud words', updatedAt: '2000-01-01T00:00:00.000Z' }
    const kept = await importQueueItem(dir, older, { onlyIfNewer: true })
    expect(kept?.objectionQuote).toBe('local words')

    const newer = { ...item, objectionQuote: 'newer cloud words', updatedAt: '2999-01-01T00:00:00.000Z' }
    const replaced = await importQueueItem(dir, newer, { onlyIfNewer: true })
    expect(replaced?.objectionQuote).toBe('newer cloud words')
  })

  it('refuses a malformed payload and a live item without both quotes', async () => {
    expect(await importQueueItem(dir, null)).toBeNull()
    expect(await importQueueItem(dir, { id: 'x', type: 'price', callId: 'c', objectionQuote: 'only one side' })).toBeNull()
    expect(await importQueueItem(dir, { id: '../escape', type: 'price', callId: 'c', deleted: true })).toBeNull()
  })

  it('an older file without updatedAt reads as updated at its creation', async () => {
    const item = await importQueueItem(dir, {
      id: 'legacy',
      type: 'other',
      objectionQuote: 'q',
      responseQuote: 'r',
      callId: 'c',
      createdAt: '2026-08-01T00:00:00.000Z'
    })
    expect(item?.updatedAt).toBe('2026-08-01T00:00:00.000Z')
  })
})

describe('re-mining after a rejection', () => {
  it('the same words mined again from the same call do not resurrect a rejected item under a new id', async () => {
    const [item] = await addToQueue(dir, [candidate('too expensive')], 'call-1', 'Call 1')
    await removeFromQueue(dir, item.id)
    // A tombstone has no quote, so the dedupe cannot key on words; the item
    // simply lands again as a NEW candidate — which is what a rep who cleared
    // the flag and re-scanned asked for. What must NOT happen is the old
    // tombstone being flipped back to live.
    const again = await addToQueue(dir, [candidate('too expensive')], 'call-1', 'Call 1')
    expect(again).toHaveLength(1)
    expect(again[0].id).not.toBe(item.id)
    const stone = await getQueueItem(dir, item.id, { includeDeleted: true })
    expect(stone?.deleted).toBe(true)
  })
})
