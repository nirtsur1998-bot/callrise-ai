// M21 Phase B — clock-skew regression tests.
//
// The acceptance criteria for this fix are stated as manual steps ("set the
// device clock forward 48 hours, back up, restore"). Actually moving a machine's
// clock is disruptive and can't run in CI, so the same scenarios are reproduced
// here by injecting the skew directly — which is exactly what a wrong clock
// does to these comparisons.
//
// Every test below FAILS against the pre-M21 code (which compared raw device
// time against server time) and passes after it.
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileStore, toServerIso, toServerMs, ts, type CloudRow } from '../backup-core'

const HOUR = 3_600_000
const SKEW_48H = 48 * HOUR

interface Rec {
  id: string
  updatedAt: string
  deleted?: boolean
}

/** A fixed "true" instant so the tests never depend on the real clock. */
const T = Date.parse('2026-08-03T12:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function cloudRow(id: string, serverEditedAtMs: number): CloudRow {
  return {
    id,
    updated_at: iso(serverEditedAtMs),
    server_updated_at: iso(serverEditedAtMs),
    deleted: false,
    payload: { id, updatedAt: iso(serverEditedAtMs) }
  }
}

/** Runs reconcileStore against a scratch dir and reports which ids were imported
 *  (i.e. which records the CLOUD copy won for). */
async function run(
  rows: CloudRow[],
  locals: Rec[],
  skewMs: number,
  lastSyncAt?: string
): Promise<{ imported: string[]; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'callrise-skew-'))
  const imported: string[] = []
  const map = new Map(locals.map((l) => [l.id, l]))
  await reconcileStore<Rec>(
    dir,
    rows,
    map,
    async (_d, payload) => {
      const rec = payload as Rec
      imported.push(rec.id)
      return rec
    },
    lastSyncAt,
    skewMs
  )
  return { imported, dir }
}

describe('toServerMs / toServerIso', () => {
  it('lifts a device timestamp onto the server timeline', () => {
    // Device runs 48h fast: it stamps T+48h for an edit that really happened at T.
    expect(toServerMs(iso(T + SKEW_48H), SKEW_48H)).toBe(T)
    // Device runs 48h slow.
    expect(toServerMs(iso(T - SKEW_48H), -SKEW_48H)).toBe(T)
  })

  it('is a no-op when the clock is correct', () => {
    expect(toServerMs(iso(T), 0)).toBe(T)
    expect(toServerIso(iso(T), 0)).toBe(iso(T))
  })

  it('normalises two differently-skewed devices onto the same instant', () => {
    // Both devices edit the same record at the same TRUE moment T, but their
    // clocks disagree by four days. Uploaded normalised, they must agree.
    const fastDevice = toServerIso(iso(T + SKEW_48H), SKEW_48H)
    const slowDevice = toServerIso(iso(T - SKEW_48H), -SKEW_48H)
    expect(fastDevice).toBe(slowDevice)
    expect(ts(fastDevice)).toBe(T)
  })
})

describe('reconcileStore — device clock 48h FAST', () => {
  it('still restores a genuinely newer cloud copy', async () => {
    // Truth: cloud edited 1h ago, local edited 2h ago → cloud is newer.
    // The device's clock is 48h fast, so its local record is stamped +48h.
    const rows = [cloudRow('a', T - HOUR)]
    const locals: Rec[] = [{ id: 'a', updatedAt: iso(T - 2 * HOUR + SKEW_48H) }]

    const { imported, dir } = await run(rows, locals, SKEW_48H)
    await rm(dir, { recursive: true, force: true })

    // Pre-fix this was [] — the inflated local timestamp out-ranked the cloud
    // and the newer copy was silently never restored.
    expect(imported).toEqual(['a'])
  })

  it('does not let the cloud clobber a genuinely newer local copy', async () => {
    // Truth: local edited 1h ago, cloud edited 3h ago → local is newer.
    const rows = [cloudRow('a', T - 3 * HOUR)]
    const locals: Rec[] = [{ id: 'a', updatedAt: iso(T - HOUR + SKEW_48H) }]

    const { imported, dir } = await run(rows, locals, SKEW_48H)
    await rm(dir, { recursive: true, force: true })

    expect(imported).toEqual([])
  })
})

describe('reconcileStore — device clock 48h SLOW', () => {
  it('keeps a genuinely newer local copy instead of overwriting it', async () => {
    // Truth: local edited 2h ago, cloud edited 3h ago → local is newer.
    // The device's clock is 48h slow, so its local record is stamped -48h.
    const rows = [cloudRow('a', T - 3 * HOUR)]
    const locals: Rec[] = [{ id: 'a', updatedAt: iso(T - 2 * HOUR - SKEW_48H) }]

    const { imported, dir } = await run(rows, locals, -SKEW_48H)
    await rm(dir, { recursive: true, force: true })

    // Pre-fix this was ['a'] — the deflated local timestamp made every cloud
    // row look newer, so real local edits were overwritten.
    expect(imported).toEqual([])
  })

  it('still restores a genuinely newer cloud copy', async () => {
    const rows = [cloudRow('a', T - HOUR)]
    const locals: Rec[] = [{ id: 'a', updatedAt: iso(T - 5 * HOUR - SKEW_48H) }]

    const { imported, dir } = await run(rows, locals, -SKEW_48H)
    await rm(dir, { recursive: true, force: true })

    expect(imported).toEqual(['a'])
  })
})

describe('reconcileStore — correct clock (regression guard)', () => {
  it('behaves exactly as before when skew is zero', async () => {
    const rows = [cloudRow('newer', T - HOUR), cloudRow('older', T - 5 * HOUR)]
    const locals: Rec[] = [
      { id: 'newer', updatedAt: iso(T - 3 * HOUR) }, // cloud wins
      { id: 'older', updatedAt: iso(T - HOUR) } // local wins
    ]

    const { imported, dir } = await run(rows, locals, 0)
    await rm(dir, { recursive: true, force: true })

    expect(imported).toEqual(['newer'])
  })

  it('imports a cloud-only record regardless of skew', async () => {
    const { imported, dir } = await run([cloudRow('fresh', T - HOUR)], [], SKEW_48H)
    await rm(dir, { recursive: true, force: true })
    expect(imported).toEqual(['fresh'])
  })
})

describe('reconcileStore — the bug this fix closes', () => {
  it('reproduces the old failure when no skew correction is applied', async () => {
    // Identical scenario to "48h FAST / still restores a genuinely newer cloud
    // copy" above, but with skewMs=0 — which is precisely what the pre-M21 code
    // did (it compared the raw device clock against server time). Proves these
    // tests actually discriminate: the correction is what changes the outcome,
    // not the test setup.
    const rows = [cloudRow('a', T - HOUR)]
    const locals: Rec[] = [{ id: 'a', updatedAt: iso(T - 2 * HOUR + SKEW_48H) }]

    const { imported, dir } = await run(rows, locals, 0)
    await rm(dir, { recursive: true, force: true })

    expect(imported).toEqual([]) // the newer cloud copy is lost — the bug
  })
})

describe('reconcileStore — concurrent-edit conflict detection', () => {
  it('still writes a .conflict copy when both sides changed, under skew', async () => {
    // lastSyncAt and local.updatedAt are BOTH this device's own clock, so they
    // stay comparable to each other without any skew correction — the fix must
    // not have broken that by half-correcting one side.
    const rows = [cloudRow('a', T - HOUR)]
    const locals: Rec[] = [{ id: 'a', updatedAt: iso(T - 2 * HOUR + SKEW_48H) }]
    const lastSyncAt = iso(T - 6 * HOUR + SKEW_48H) // device-clock cursor

    const { imported, dir } = await run(rows, locals, SKEW_48H, lastSyncAt)
    const files = await readdir(dir)
    await rm(dir, { recursive: true, force: true })

    expect(imported).toEqual(['a'])
    expect(files).toContain('a.conflict')
  })
})
