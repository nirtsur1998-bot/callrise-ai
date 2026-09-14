// BUG-279 — a pull must not manufacture a newer edit.
//
// reconcileStore stamped every imported record with the server's WRITE time
// (`server_updated_at`) instead of the row's EDIT time (`updated_at`). The next
// push uploaded that write time as the edit time, the trigger accepted it as
// newer, stamped a newer write time, and the next pull imported that — every
// record, every cycle. Measured on the founder's machine on 2026-09-14: 432 of
// 432 records across five stores carried the same few milliseconds of
// "last edited" (175 calls stamped 11:37:17.483Z). The visible casualty was a
// deal note edited on this machine and overwritten by the other machine's
// re-upload of the stale copy; BUG-187's guard kept it as `<id>.conflict`.
//
// These tests enter where the product enters: the real deal importer with the
// same `onlyIfNewer` guard pullAll passes it, against a scratch directory.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLOCK_SKEW_DEAD_BAND_MS,
  effectiveSkewMs,
  reconcileStore,
  toDeviceIso,
  toServerIso,
  type CloudRow
} from '../backup-core'
import { importDeal, type Deal } from '../deals-fs'

const MIN = 60_000
const HOUR = 60 * MIN
/** The instant the lost deal note was written. */
const T = Date.parse('2026-09-14T10:35:07.478Z')
const iso = (ms: number): string => new Date(ms).toISOString()

/** A cloud row whose edit time and write time DIFFER — the previous fixtures
 *  set them equal, which is exactly why the restamp went unnoticed. */
function row(
  id: string,
  editedAtMs: number,
  writtenAtMs: number,
  extra: Record<string, unknown>
): CloudRow {
  return {
    id,
    updated_at: iso(editedAtMs),
    server_updated_at: iso(writtenAtMs),
    deleted: false,
    payload: { id, updatedAt: iso(editedAtMs), ...extra }
  }
}

const deal = (notes: string): Record<string, unknown> => ({
  title: 'Harvey — portfolio top-up',
  contactId: 'c-harvey',
  stageId: 'proposal',
  createdAt: iso(T - 3 * HOUR),
  notes
})

const guardedImportDeal = (dir: string, p: unknown): Promise<Deal | null> =>
  importDeal(dir, p, { onlyIfNewer: true })

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-bug279-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function readDeal(id: string): Promise<Deal> {
  return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as Deal
}

describe('BUG-279 — the instant a pull carries onto the local record', () => {
  it('is the row’s EDIT time, not the server’s WRITE time', async () => {
    const seen: string[] = []
    await reconcileStore(
      dir,
      [row('d1', T - HOUR, T, deal('edited an hour before it was pushed'))],
      new Map(),
      async (_d, payload) => {
        seen.push((payload as Deal).updatedAt)
        return payload as Deal
      },
      undefined,
      0
    )
    expect(seen).toEqual([iso(T - HOUR)])
  })

  it('a pull of a record this machine already holds rewrites NOTHING (real importer)', async () => {
    // This machine made the edit at T-1h and pushed it; the server wrote the
    // row at T. Ten minutes later the pull runs. Before the fix the record came
    // back stamped T, the file was rewritten, and the next push re-uploaded it
    // as a fresh edit — forever.
    const seeded = await importDeal(dir, { id: 'd1', updatedAt: iso(T - HOUR), ...deal('mine') })
    expect(seeded).not.toBeNull()
    const before = await readFile(join(dir, 'd1.json'), 'utf8')

    const changed = await reconcileStore(
      dir,
      [row('d1', T - HOUR, T, deal('mine'))],
      new Map([['d1', seeded as Deal]]),
      guardedImportDeal,
      iso(T - 30 * MIN),
      0
    )

    expect(changed).toBe(0)
    expect(await readFile(join(dir, 'd1.json'), 'utf8')).toBe(before)
    expect((await readDeal('d1')).updatedAt).toBe(iso(T - HOUR))
    expect(await readdir(dir)).toEqual(['d1.json']) // and no .conflict left behind
  })

  it('a stale copy re-uploaded by the other machine cannot out-rank a genuine edit here', async () => {
    // The other machine holds the old note (edited T-1h) and — through the
    // loop — re-uploads it at T+5min, so the server's write time is newer than
    // this machine's real edit at T. Server-clock "newest wins" says cloud; the
    // importer's edit-time guard must say no, and nothing must be lost.
    const mine = await importDeal(dir, {
      id: 'd1',
      updatedAt: iso(T),
      ...deal('SYNTHETIC TEST DATA')
    })
    expect(mine).not.toBeNull()

    const changed = await reconcileStore(
      dir,
      [row('d1', T - HOUR, T + 5 * MIN, deal(''))],
      new Map([['d1', mine as Deal]]),
      guardedImportDeal,
      iso(T - 30 * MIN), // this machine's edit at T is after the last sync → "both moved"
      0
    )

    expect(changed).toBe(0)
    const after = await readDeal('d1')
    expect(after.notes).toBe('SYNTHETIC TEST DATA')
    expect(after.updatedAt).toBe(iso(T))
    expect(await readdir(dir)).toEqual(['d1.json'])
  })

  it('a genuinely newer edit from the other machine still lands', async () => {
    // The guard must not have become a wall: an edit that IS newer imports.
    const mine = await importDeal(dir, { id: 'd1', updatedAt: iso(T - HOUR), ...deal('old') })
    const changed = await reconcileStore(
      dir,
      [row('d1', T, T + MIN, deal('newer, from the work machine'))],
      new Map([['d1', mine as Deal]]),
      guardedImportDeal,
      iso(T - 30 * MIN),
      0
    )
    expect(changed).toBe(1)
    const after = await readDeal('d1')
    expect(after.notes).toBe('newer, from the work machine')
    expect(after.updatedAt).toBe(iso(T))
  })
})

describe('BUG-279 — the skew dead band', () => {
  it('a normal machine applies NO correction, so pull-then-push is byte-identical', () => {
    // The founder's machine measured -425 ms on 2026-09-14.
    const skew = effectiveSkewMs(-425)
    expect(skew).toBe(0)
    const stored = iso(T - HOUR)
    expect(toServerIso(toDeviceIso(stored, skew), skew)).toBe(stored)
  })

  it('a clock that is actually wrong is still corrected (M21 stays in force)', () => {
    const fast = 48 * HOUR
    expect(effectiveSkewMs(fast)).toBe(fast)
    expect(effectiveSkewMs(-fast)).toBe(-fast)
    expect(effectiveSkewMs(CLOCK_SKEW_DEAD_BAND_MS)).toBe(CLOCK_SKEW_DEAD_BAND_MS)
    expect(effectiveSkewMs(CLOCK_SKEW_DEAD_BAND_MS - 1)).toBe(0)
  })

  it('an unmeasurable skew is 0 — the previous behaviour, never a failure', () => {
    expect(effectiveSkewMs(null)).toBe(0)
    expect(effectiveSkewMs(undefined)).toBe(0)
    expect(effectiveSkewMs(Number.NaN)).toBe(0)
  })
})

describe('BUG-279 — source pins (the fix is only real where the product calls it)', () => {
  const src = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

  it('reconcileStore stamps from updated_at and never from server_updated_at', () => {
    const core = src('backup-core.ts')
    expect(core).toContain('payload.updatedAt = toDeviceIso(row.updated_at, skewMs)')
    expect(core).not.toContain('toDeviceIso(row.server_updated_at')
  })

  it('both skew measurements — push and pull — go through the dead band', () => {
    const backup = src('backup.ts')
    const measured = backup.match(/measureClockSkew\(client\)/g) ?? []
    expect(measured.length).toBe(2)
    expect(backup).toContain('const skewMs = effectiveSkewMs(await measureClockSkew(client))')
    expect(backup).toContain('const skewMs = effectiveSkewMs(measuredSkew)')
    // The raw measurement still reaches state — it drives the skew warning.
    expect(backup).toContain('clockSkewMs: measuredSkew')
  })
})
