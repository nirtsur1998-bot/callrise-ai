import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  purgeCompanionFiles,
  companionPaths,
  sweepOrphanedCompanions,
  recordIsGone,
  RECORD_COMPANION_SUFFIXES
} from '../companion-files'

/**
 * BUG-139 — a deleted record must not leave its content behind in a companion
 * file.
 *
 * These assert the GUARANTEE, not the implementation: after a delete, no file
 * anywhere in the record's directory still contains the record's content. That
 * phrasing matters — a test that checked "unlink was called on <id>.conflict"
 * would pass while a differently-named companion kept the transcript, which is
 * precisely how this bug survived. So the assertion reads the directory back
 * and looks for the words.
 */

let dir: string

const SECRET = 'the buyer said something confidential here'

async function writeRecord(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify({ id, preview: SECRET, ...extra }))
}

/** Does ANY file in the directory still contain the secret? */
async function secretSurvivesAnywhere(): Promise<string[]> {
  const found: string[] = []
  for (const name of await fs.readdir(dir)) {
    const raw = await fs.readFile(join(dir, name), 'utf8').catch(() => '')
    if (raw.includes(SECRET)) found.push(name)
  }
  return found
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'companion-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('purgeCompanionFiles', () => {
  it('removes a .conflict copy holding the pre-deletion content', async () => {
    await writeRecord('abc')
    await fs.writeFile(join(dir, 'abc.conflict'), JSON.stringify({ id: 'abc', preview: SECRET }))

    // The bug, reproduced: tombstoning the record alone leaves the secret.
    await writeRecord('abc', { deleted: true, preview: '' })
    expect(await secretSurvivesAnywhere()).toEqual(['abc.conflict'])

    const removed = await purgeCompanionFiles(dir, 'abc')
    expect(removed).toBe(1)
    expect(await secretSurvivesAnywhere()).toEqual([])
  })

  it('removes an orphaned atomic-write staging file', async () => {
    // atomic-write names these `<id>.json.<uuid>.tmp` — the uuid is not
    // knowable from the id, so this can only be found by listing. A test that
    // assumed `<id>.tmp` would pass against an implementation that misses the
    // real files.
    await writeRecord('abc', { deleted: true, preview: '' })
    await fs.writeFile(
      join(dir, 'abc.json.9f8c1d2e-0000-4000-8000-000000000000.tmp'),
      JSON.stringify({ id: 'abc', preview: SECRET })
    )
    // Tombstoned first, so "the secret survives nowhere" is a real assertion.
    // The first draft of this test left the record live, which meant the live
    // record legitimately still held the secret and the assertion could only
    // ever fail — it was testing the fixture, not the fix.
    expect(await secretSurvivesAnywhere()).toEqual([
      'abc.json.9f8c1d2e-0000-4000-8000-000000000000.tmp'
    ])
    await purgeCompanionFiles(dir, 'abc')
    expect(await secretSurvivesAnywhere()).toEqual([])
  })

  it('never touches the record itself, or another record', async () => {
    await writeRecord('abc')
    await writeRecord('other')
    await fs.writeFile(join(dir, 'other.conflict'), '{}')

    await purgeCompanionFiles(dir, 'abc')

    const names = (await fs.readdir(dir)).sort()
    expect(names).toEqual(['abc.json', 'other.conflict', 'other.json'])
  })

  it('is safe to call when there is nothing to purge', async () => {
    await writeRecord('abc')
    await expect(purgeCompanionFiles(dir, 'abc')).resolves.toBe(0)
    await expect(purgeCompanionFiles(dir, 'never-existed')).resolves.toBe(0)
  })

  it('enumerates every declared suffix', async () => {
    // Guards the list itself: a suffix added to RECORD_COMPANION_SUFFIXES but
    // not handled by companionPaths would silently never be purged.
    const paths = await companionPaths(dir, 'abc')
    for (const suffix of RECORD_COMPANION_SUFFIXES) {
      expect(paths.some((p) => p.endsWith(`abc${suffix}`))).toBe(true)
    }
  })
})

describe('recordIsGone', () => {
  it('reports absent and tombstoned records as gone, live ones as present', async () => {
    await writeRecord('live')
    await writeRecord('dead', { deleted: true })
    expect(await recordIsGone(dir, 'live')).toBe(false)
    expect(await recordIsGone(dir, 'dead')).toBe(true)
    expect(await recordIsGone(dir, 'absent')).toBe(true)
  })

  it('treats an unparseable record as PRESENT, so its companions are left alone', async () => {
    // The conservative direction. Sweeping on the strength of a bad read would
    // delete a user's data because of a torn write.
    await fs.writeFile(join(dir, 'torn.json'), '{ not json')
    expect(await recordIsGone(dir, 'torn')).toBe(false)
  })
})

describe('sweepOrphanedCompanions (the backlog half)', () => {
  let base: string
  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'companion-sweep-'))
    await fs.mkdir(join(base, 'calls'), { recursive: true })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('removes a companion beside a TOMBSTONED record', async () => {
    const d = join(base, 'calls')
    await fs.writeFile(join(d, 'x.json'), JSON.stringify({ id: 'x', deleted: true }))
    await fs.writeFile(join(d, 'x.conflict'), JSON.stringify({ preview: SECRET }))

    expect(await sweepOrphanedCompanions(base)).toBe(1)
    expect(await fs.readdir(d)).toEqual(['x.json'])
  })

  it('removes a companion whose record is GONE entirely', async () => {
    const d = join(base, 'calls')
    await fs.writeFile(join(d, 'y.conflict'), JSON.stringify({ preview: SECRET }))
    expect(await sweepOrphanedCompanions(base)).toBe(1)
    expect(await fs.readdir(d)).toEqual([])
  })

  it('LEAVES a .conflict beside a live record — it may be a real conflict', async () => {
    // The load-bearing negative. A genuine two-device conflict is the entire
    // reason the mechanism exists; sweeping those away would destroy the one
    // case the user is supposed to resolve. If this test ever goes green by
    // being deleted, the sweep has become a data-loss bug.
    const d = join(base, 'calls')
    await fs.writeFile(join(d, 'z.json'), JSON.stringify({ id: 'z' }))
    await fs.writeFile(join(d, 'z.conflict'), JSON.stringify({ id: 'z', title: 'other device' }))

    expect(await sweepOrphanedCompanions(base)).toBe(0)
    expect((await fs.readdir(d)).sort()).toEqual(['z.conflict', 'z.json'])
  })

  it('removes an orphaned staging file even beside a live record', async () => {
    // A `.tmp` is by definition a rename that never completed — it is never
    // the authoritative copy, so unlike .conflict it is always safe.
    const d = join(base, 'calls')
    await fs.writeFile(join(d, 'w.json'), JSON.stringify({ id: 'w' }))
    await fs.writeFile(join(d, 'w.json.abc-123.tmp'), JSON.stringify({ id: 'w' }))

    expect(await sweepOrphanedCompanions(base)).toBe(1)
    expect(await fs.readdir(d)).toEqual(['w.json'])
  })

  it('does not fall over on a directory that does not exist', async () => {
    await expect(sweepOrphanedCompanions(join(base, 'nope'))).resolves.toBe(0)
  })
})
