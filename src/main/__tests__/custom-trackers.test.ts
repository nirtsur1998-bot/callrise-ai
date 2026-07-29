import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listCustomTrackers, saveCustomTrackers, type StoredTracker } from '../custom-trackers'

const VALID: StoredTracker = {
  id: 'custom-procurement',
  patterns: ['procurement team', 'goes through procurement'],
  card: {
    id: 'custom-procurement',
    label: 'Procurement',
    say: 'Loop in their process early.',
    category: 'process'
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-trackers-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('listCustomTrackers', () => {
  it('returns an empty list when nothing has been saved yet', async () => {
    expect(await listCustomTrackers(dir)).toEqual([])
  })

  it('never throws on a corrupt file — the starter library alone must still work', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'custom-trackers.json'), '{ not valid json')
    expect(await listCustomTrackers(dir)).toEqual([])
  })
})

describe('saveCustomTrackers / listCustomTrackers round-trip', () => {
  it('persists a valid tracker and reads it back unchanged', async () => {
    await saveCustomTrackers(dir, [VALID])
    expect(await listCustomTrackers(dir)).toEqual([VALID])
  })

  it('replaces the whole list rather than merging', async () => {
    await saveCustomTrackers(dir, [VALID])
    await saveCustomTrackers(dir, [])
    expect(await listCustomTrackers(dir)).toEqual([])
  })

  it('drops a tracker with no patterns — it would fire on everything', async () => {
    const bad = { ...VALID, patterns: [] }
    const saved = await saveCustomTrackers(dir, [bad])
    expect(saved).toEqual([])
  })

  it('drops a tracker with an unrecognised category', async () => {
    const bad = { ...VALID, card: { ...VALID.card, category: 'weather' } }
    const saved = await saveCustomTrackers(dir, [bad])
    expect(saved).toEqual([])
  })

  it('drops a tracker missing a label or advice', async () => {
    const noLabel = { ...VALID, card: { ...VALID.card, label: '' } }
    const noSay = { ...VALID, card: { ...VALID.card, say: '' } }
    expect(await saveCustomTrackers(dir, [noLabel])).toEqual([])
    expect(await saveCustomTrackers(dir, [noSay])).toEqual([])
  })

  it('rejects an id that could be used for path traversal', async () => {
    const bad = { ...VALID, id: '../../etc/passwd', card: { ...VALID.card, id: '../evil' } }
    const saved = await saveCustomTrackers(dir, [bad])
    expect(saved).toEqual([])
  })

  it('deduplicates by id, keeping the first', async () => {
    const second = { ...VALID, patterns: ['different phrase entirely'] }
    const saved = await saveCustomTrackers(dir, [VALID, second])
    expect(saved).toHaveLength(1)
    expect(saved[0].patterns).toEqual(VALID.patterns)
  })

  it('caps at 50 trackers', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...VALID,
      id: `custom-${i}`,
      card: { ...VALID.card, id: `custom-${i}` }
    }))
    const saved = await saveCustomTrackers(dir, many)
    expect(saved).toHaveLength(50)
  })

  it('ignores garbage input instead of throwing', async () => {
    expect(await saveCustomTrackers(dir, 'not an array')).toEqual([])
    expect(await saveCustomTrackers(dir, null)).toEqual([])
    expect(await saveCustomTrackers(dir, [null, 42, 'x', {}])).toEqual([])
  })
})
