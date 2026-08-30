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
//
// Merged (2026-08-04) with a second, independently-written suite for the same
// module covering reconcileStore's non-skew-related behavior (malformed rows,
// tombstones, multi-row processing) — kept as its own describe block below
// rather than folded in, so each suite's own history/intent stays legible.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reconcileStore,
  toServerIso,
  toServerMs,
  toDeviceIso,
  ts,
  type CloudRow
} from '../backup-core'

const HOUR = 3_600_000
const SKEW_48H = 48 * HOUR

interface Rec {
  id: string
  updatedAt: string
  deleted?: boolean
  /** BUG-138 — conflict detection now compares CONTENT, not just timestamps,
   *  so these fixtures need a field that can actually differ between the two
   *  sides. Without one, every cloud/local pair is identical and no conflict
   *  copy should (or does) get written. */
  title?: string
  note?: string
}

/** A fixed "true" instant so the tests never depend on the real clock. */
const T = Date.parse('2026-08-03T12:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function cloudRow(
  id: string,
  serverEditedAtMs: number,
  extraPayload: Record<string, unknown> = {}
): CloudRow {
  return {
    id,
    updated_at: iso(serverEditedAtMs),
    server_updated_at: iso(serverEditedAtMs),
    deleted: false,
    payload: { id, updatedAt: iso(serverEditedAtMs), ...extraPayload }
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

  it('round-trips: server -> device -> server is identity', () => {
    // The two conversions are inverses. If they ever drift apart, timestamps
    // get corrected twice somewhere and ordering silently rots.
    const serverIso = iso(T)
    const onDevice = toDeviceIso(serverIso, SKEW_48H)
    expect(ts(onDevice)).toBe(T + SKEW_48H)
    expect(toServerMs(onDevice, SKEW_48H)).toBe(T)
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

describe('payload re-stamping (the onlyIfNewer veto)', () => {
  it('hands the importer a payload stamped on THIS device’s clock', async () => {
    // The store importers re-check payload.updatedAt against the on-disk
    // updatedAt themselves, as plain device-vs-device times. If the payload
    // still carried server time (or the pushing device's clock), that
    // un-corrected re-check would silently veto the decision made here and the
    // 48h-fast restore would still fail.
    const dir = await mkdtemp(join(tmpdir(), 'callrise-skew-'))
    const seen: string[] = []
    await reconcileStore<Rec>(
      dir,
      [cloudRow('a', T - HOUR)],
      new Map([['a', { id: 'a', updatedAt: iso(T - 2 * HOUR + SKEW_48H) }]]),
      async (_d, payload) => {
        seen.push((payload as Rec).updatedAt)
        return payload as Rec
      },
      undefined,
      SKEW_48H
    )
    await rm(dir, { recursive: true, force: true })

    expect(seen).toHaveLength(1)
    // Server instant T-1h expressed on a clock running 48h fast.
    expect(ts(seen[0])).toBe(T - HOUR + SKEW_48H)
    // And critically: newer than the local record's own stamp, so the
    // importer's own guard agrees rather than overruling.
    expect(ts(seen[0])).toBeGreaterThan(ts(iso(T - 2 * HOUR + SKEW_48H)))
  })

  it('re-stamps cloud-only records too, so a foreign clock never lands on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'callrise-skew-'))
    const seen: string[] = []
    await reconcileStore<Rec>(
      dir,
      [cloudRow('fresh', T - HOUR)],
      new Map(),
      async (_d, payload) => {
        seen.push((payload as Rec).updatedAt)
        return payload as Rec
      },
      undefined,
      SKEW_48H
    )
    await rm(dir, { recursive: true, force: true })
    expect(ts(seen[0])).toBe(T - HOUR + SKEW_48H)
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
  // BUG-138 — this expectation was CORRECTED, not relaxed. As written, its
  // fixture gave the cloud and local sides identical content (cloudRow's
  // payload is {id, updatedAt} and the local Rec is {id, updatedAt}), so it
  // asserted that a .conflict copy is written when the two versions do not
  // actually differ. That is precisely the shipped bug: on the founder's own
  // machine it produced 201 .conflict files, every one byte-identical to the
  // record beside it. The test's real INTENT — "conflict detection still
  // works under skew" — is valid and kept; the fixture now contains a genuine
  // content difference so it tests a genuine conflict.
  it('still writes a .conflict copy when both sides changed, under skew', async () => {
    // lastSyncAt and local.updatedAt are BOTH this device's own clock, so they
    // stay comparable to each other without any skew correction — the fix must
    // not have broken that by half-correcting one side.
    const rows = [cloudRow('a', T - HOUR, { title: 'edited on the other machine' })]
    const locals: Rec[] = [
      { id: 'a', updatedAt: iso(T - 2 * HOUR + SKEW_48H), title: 'edited here' }
    ]
    const lastSyncAt = iso(T - 6 * HOUR + SKEW_48H) // device-clock cursor

    const { imported, dir } = await run(rows, locals, SKEW_48H, lastSyncAt)
    const files = await readdir(dir)
    await rm(dir, { recursive: true, force: true })

    expect(imported).toEqual(['a'])
    expect(files).toContain('a.conflict')
  })

  // BUG-138 proper: the timestamps say "both sides changed", but the content
  // says nothing did. Real trigger, seen in the wild: the app is killed
  // mid-sync so lastSyncAt never advances, and the next restore then treats
  // every untouched record as a concurrent edit.
  it('writes NO conflict copy when the two versions are identical', async () => {
    const rows = [cloudRow('a', T - HOUR, { title: 'same' })]
    const locals: Rec[] = [{ id: 'a', updatedAt: iso(T - 2 * HOUR + SKEW_48H), title: 'same' }]
    const lastSyncAt = iso(T - 6 * HOUR + SKEW_48H)

    const { imported, dir } = await run(rows, locals, SKEW_48H, lastSyncAt)
    const files = await readdir(dir)
    await rm(dir, { recursive: true, force: true })

    expect(imported).toEqual(['a']) // the cloud copy still wins and imports
    expect(files).not.toContain('a.conflict') // but nothing was preserved
  })

  it('does not manufacture a whole burst of conflicts after a killed sync', async () => {
    // The reported symptom, as one assertion: many records, none actually
    // edited, one stale lastSyncAt. Before the fix this produced one
    // .conflict per record — 201 of them on the real machine, which buries
    // any genuine conflict the user actually needs to look at.
    const ids = ['a', 'b', 'c', 'd', 'e']
    const rows = ids.map((id) => cloudRow(id, T - HOUR, { title: id }))
    const locals: Rec[] = ids.map((id) => ({
      id,
      updatedAt: iso(T - 2 * HOUR + SKEW_48H),
      title: id
    }))
    const lastSyncAt = iso(T - 6 * HOUR + SKEW_48H)

    const { dir } = await run(rows, locals, SKEW_48H, lastSyncAt)
    const files = await readdir(dir)
    await rm(dir, { recursive: true, force: true })

    expect(files.filter((f) => f.endsWith('.conflict'))).toEqual([])
  })

  it('ignores property ORDER, which JSON.stringify would otherwise call a difference', async () => {
    const rows = [cloudRow('a', T - HOUR, { title: 'x', note: 'y' })]
    const locals: Rec[] = [
      // Same fields, declared in the opposite order.
      { note: 'y', title: 'x', id: 'a', updatedAt: iso(T - 2 * HOUR + SKEW_48H) } as Rec
    ]
    const lastSyncAt = iso(T - 6 * HOUR + SKEW_48H)

    const { dir } = await run(rows, locals, SKEW_48H, lastSyncAt)
    const files = await readdir(dir)
    await rm(dir, { recursive: true, force: true })

    expect(files).not.toContain('a.conflict')
  })
})

// --- General reconcileStore behavior (independent suite, merged 2026-08-04) -
// Written without knowledge of the skew work above; covers malformed input,
// tombstone handling, and multi-row processing that the skew-focused suite
// never exercised. Runs against the same reconcileStore — the 6th (skewMs)
// parameter is omitted throughout and defaults to 0, so every scenario here
// is exactly the pre-M21 behavior the skew fix was required not to change.

interface Local {
  id: string
  updatedAt: string
  deleted?: boolean
  title?: string
}

function row(partial: Partial<CloudRow> & { id: string }): CloudRow {
  return {
    updated_at: partial.updated_at ?? '2026-01-01T00:00:00.000Z',
    server_updated_at: partial.server_updated_at ?? '2026-01-01T00:00:00.000Z',
    deleted: partial.deleted ?? false,
    payload: partial.payload ?? { id: partial.id, updatedAt: '2026-01-01T00:00:00.000Z' },
    ...partial
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-reconcile-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ts', () => {
  it('parses a real ISO timestamp', () => {
    expect(ts('2026-01-15T00:00:00.000Z')).toBe(Date.parse('2026-01-15T00:00:00.000Z'))
  })

  it('orders anything unparseable FIRST rather than crashing', () => {
    expect(ts(undefined)).toBe(0)
    expect(ts(null)).toBe(0)
    expect(ts('not a date')).toBe(0)
    expect(ts('')).toBe(0)
  })
})

describe('reconcileStore — general behavior', () => {
  it('imports a cloud-only record', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const rows = [row({ id: 'a' })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(1)
    expect(importRecord).toHaveBeenCalledOnce()
  })

  it('never imports a cloud tombstone for something never seen locally', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const rows = [row({ id: 'a', deleted: true })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('leaves a local-only record alone (never appears in rows, so never touched)', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const locals = new Map<string, Local>([
      ['local-only', { id: 'local-only', updatedAt: '2026-01-01T00:00:00.000Z' }]
    ])
    const changed = await reconcileStore(dir, [], locals, importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('local wins when it is the same age or newer — no import, no conflict file', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-02-01T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-01-01T00:00:00.000Z' })]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
    await expect(access(join(dir, 'a.conflict'))).rejects.toThrow()
  })

  it('cloud wins when newer, and imports it', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-02-01T00:00:00.000Z' })]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(1)
    expect(importRecord).toHaveBeenCalledOnce()
  })

  it('uses the server clock, never the device-supplied updated_at, to decide freshness', async () => {
    // A device with a fast clock inflates updated_at; server_updated_at is the
    // one source of truth this function is allowed to trust.
    const importRecord = vi.fn(async () => ({}) as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-03-01T00:00:00.000Z' }]
    ])
    const rows = [
      row({
        id: 'a',
        updated_at: '2099-01-01T00:00:00.000Z', // implausibly "future", but not trusted
        server_updated_at: '2026-01-01T00:00:00.000Z' // actually older than local
      })
    ]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('keeps the losing local copy as a .conflict file on a genuine two-machine concurrent edit', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const local: Local = { id: 'a', updatedAt: '2026-01-15T00:00:00.000Z', title: 'local edit' }
    const locals = new Map<string, Local>([['a', local]])
    const rows = [
      row({
        id: 'a',
        server_updated_at: '2026-01-20T00:00:00.000Z',
        payload: { id: 'a', updatedAt: '2026-01-20T00:00:00.000Z', title: 'cloud edit' }
      })
    ]
    // Local was edited (2026-01-15) AFTER the last sync (2026-01-10), while the
    // cloud was ALSO edited more recently (2026-01-20) — both sides changed.
    const changed = await reconcileStore(
      dir,
      rows,
      locals,
      importRecord,
      '2026-01-10T00:00:00.000Z'
    )
    expect(changed).toBe(1)
    const conflict = JSON.parse(await readFile(join(dir, 'a.conflict'), 'utf8'))
    expect(conflict.title).toBe('local edit')
  })

  it('does NOT write a conflict file when the local edit predates the last sync', async () => {
    // Local hasn't changed since the last sync — cloud winning is an ordinary
    // pull, not a concurrent-edit collision.
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-05T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-01-20T00:00:00.000Z' })]
    await reconcileStore(dir, rows, locals, importRecord, '2026-01-10T00:00:00.000Z')
    await expect(access(join(dir, 'a.conflict'))).rejects.toThrow()
  })

  it('never writes a conflict file for a local record that is itself a tombstone', async () => {
    // A deleted local record losing to a cloud update is not a "concurrent
    // edit" worth preserving a copy of — there is nothing meaningful to keep.
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-15T00:00:00.000Z', deleted: true }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-01-20T00:00:00.000Z' })]
    await reconcileStore(dir, rows, locals, importRecord, '2026-01-10T00:00:00.000Z')
    await expect(access(join(dir, 'a.conflict'))).rejects.toThrow()
  })

  it('applies a cloud tombstone locally only when it is newer', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', deleted: true, server_updated_at: '2026-02-01T00:00:00.000Z' })]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(1)
    const [, payload] = importRecord.mock.calls[0]
    expect((payload as Record<string, unknown>).deleted).toBe(true)
  })

  it('skips a malformed row (no payload, or a non-object payload) without throwing', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const rows = [
      row({ id: 'a', payload: null }),
      row({ id: 'b', payload: 'not an object' }),
      row({ id: 'c', payload: undefined })
    ]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('does not count an import that the store rejected (importRecord returned null)', async () => {
    const importRecord = vi.fn(async () => null)
    const rows = [row({ id: 'a' })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(0)
  })

  it('processes multiple rows independently and returns the total changed', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', deleted: true })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    // 'a' and 'b' are cloud-only inserts; 'c' is a tombstone never seen locally.
    expect(changed).toBe(2)
  })
})
