// BUG-187 — the conflict guard was asking the wrong question.
//
// A `.conflict` copy exists to preserve a local version that a remote edit is
// about to overwrite. The old guard decided that by comparing the local record
// against the UPLOADED PROJECTION — so it asked "did the projection change?"
// when the question is "will importing this lose anything?".
//
// The projection is not the record and never was: callBackupPayload emits
// `dealId: call.dealId ?? null` for a key the record omits, hard-blanks
// `preview`/`segments` to keep the transcript off the wire, and carries none of
// the KEEP_LOCAL fields. Measured on the founder's store: the old predicate
// returned true for 196 of 196 reachable call records in BOTH sync scopes. It
// never once prevented a conflict copy, and 214 files sat on the profile.
//
// It could not be repaired by fixing those normalisations. Leave-one-out over
// the same 196: neutralising ANY single differing key silenced 0 records in the
// default scope. Three of the four causing families are things the payload is
// SUPPOSED to differ by.
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reconcileStore, type CloudRow } from '../backup-core'

type Rec = { id: string; updatedAt: string; deleted?: boolean; [k: string]: unknown }

const T = Date.parse('2026-09-10T12:00:00.000Z')
const HOUR = 3_600_000
const iso = (ms: number): string => new Date(ms).toISOString()

function cloudRow(id: string, serverMs: number, payload: Record<string, unknown>): CloudRow {
  return {
    id,
    updated_at: iso(serverMs),
    server_updated_at: iso(serverMs),
    deleted: false,
    payload: { id, updatedAt: iso(serverMs), ...payload }
  }
}

/**
 * `importRecord` here is the IMPORTER'S CONTRACT, not a pass-through: it
 * preserves the local values of KEEP_LOCAL-style keys exactly as `importCall`
 * does since BUG-242. That is the whole point of the fix — the guard now
 * compares against what the importer WRITES, so a test whose importer ignores
 * the local record would prove nothing about it.
 */
async function run(
  rows: CloudRow[],
  locals: Rec[],
  lastSyncAt: string | undefined,
  keepLocalKeys: string[] = []
): Promise<{ dir: string; files: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'bug187-'))
  const map = new Map(locals.map((l) => [l.id, l]))
  await reconcileStore<Rec>(
    dir,
    rows,
    map,
    async (d, payload) => {
      const incoming = payload as Rec
      const local = map.get(incoming.id)
      const written: Rec = { ...incoming }
      for (const k of keepLocalKeys) {
        if (local && local[k] !== undefined) written[k] = local[k]
      }
      await writeFile(join(d, `${incoming.id}.json`), JSON.stringify(written), 'utf8')
      return written
    },
    lastSyncAt,
    0
  )
  return { dir, files: await readdir(dir) }
}

const EDITED_HERE = iso(T - 2 * HOUR)
const LAST_SYNC = iso(T - 6 * HOUR)

describe('BUG-187 — a conflict copy is kept only when importing DISCARDS something', () => {
  it('keeps one when the other machine overwrote a value this one has', async () => {
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { title: 'renamed over there' })],
      [{ id: 'a', updatedAt: EDITED_HERE, title: 'renamed here' }],
      LAST_SYNC
    )
    await rm(dir, { recursive: true, force: true })
    expect(files, 'a real losing edit must be preserved').toContain('a.conflict')
  })

  it("writes NONE for BUG-138's case — the timestamps moved, the content did not", async () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const { dir, files } = await run(
      ids.map((id) => cloudRow(id, T - HOUR, { title: id })),
      ids.map((id) => ({ id, updatedAt: EDITED_HERE, title: id })),
      LAST_SYNC
    )
    await rm(dir, { recursive: true, force: true })
    expect(files.filter((f) => f.endsWith('.conflict'))).toEqual([])
  })

  it('writes NONE when the importer preserved the local value anyway', async () => {
    // The cloud carries a different title, but this store's importer keeps the
    // local one — so nothing was lost and there is nothing to preserve. Under
    // the old guard this was a conflict, because the PAYLOAD differed.
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { title: 'cloud version' })],
      [{ id: 'a', updatedAt: EDITED_HERE, title: 'local version' }],
      LAST_SYNC,
      ['title']
    )
    await rm(dir, { recursive: true, force: true })
    expect(files).not.toContain('a.conflict')
  })

  it('writes NONE for an ADDITION — the cloud brought a key this record lacks', async () => {
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { title: 'same', summary: 'the cloud has one' })],
      [{ id: 'a', updatedAt: EDITED_HERE, title: 'same' }],
      LAST_SYNC
    )
    await rm(dir, { recursive: true, force: true })
    expect(files, 'gaining a field is not losing one').not.toContain('a.conflict')
  })

  it('writes NONE when an EMPTY local value is replaced by a real one', async () => {
    // Found by driving the fix over the founder's records, not by reasoning:
    // 1 of 60 still manufactured a conflict, on the one call with no local
    // transcript. The cloud brought one, preview went '' -> real text, and a
    // difference-based test called that a loss. You cannot lose what you did
    // not have.
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { preview: 'a real transcript', segments: [{ text: 'hi' }] })],
      [{ id: 'a', updatedAt: EDITED_HERE, preview: '', segments: [] }],
      LAST_SYNC
    )
    await rm(dir, { recursive: true, force: true })
    expect(files).not.toContain('a.conflict')
  })

  it('KEEPS one when a real local value is replaced by an empty one', async () => {
    // The other direction, and the one that matters: emptying a field the user
    // had filled IS a loss. Without this the previous test would be a licence
    // to discard anything by sending a blank.
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { notes: '' })],
      [{ id: 'a', updatedAt: EDITED_HERE, notes: 'something the rep typed' }],
      LAST_SYNC
    )
    await rm(dir, { recursive: true, force: true })
    expect(files, 'clearing a filled field is a loss').toContain('a.conflict')
  })

  it('writes NONE when the local map holds a PROJECTION, not a record', async () => {
    // assistant-conversations maps to `{ id, updatedAt }`. The old guard
    // compared that against a whole conversation and was structurally always
    // true — so that store should have had the MOST conflicts on the founder's
    // machine. It has zero, and that zero was read as evidence FOR the old
    // model rather than against it (taxonomy species 106).
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { title: 'a whole conversation', messages: [1, 2, 3] })],
      [{ id: 'a', updatedAt: EDITED_HERE }],
      LAST_SYNC
    )
    await rm(dir, { recursive: true, force: true })
    expect(files).not.toContain('a.conflict')
  })

  it('the pre-emptive copy is REMOVED, not merely skipped', async () => {
    // The write-then-remove ordering is a safety property: whether a copy is
    // needed can only be known after importing, and importing replaces the
    // local record. Writing first means a crash in that window leaves clutter
    // rather than losing the local version — the founder's rule from
    // downloadSalesBrainDb. This asserts the removal half actually happens, so
    // the clutter is not permanent.
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { title: 'same' })],
      [{ id: 'a', updatedAt: EDITED_HERE, title: 'same' }],
      LAST_SYNC
    )
    const kept = await readFile(join(dir, 'a.json'), 'utf8')
    await rm(dir, { recursive: true, force: true })
    expect(files).not.toContain('a.conflict')
    expect(JSON.parse(kept).id).toBe('a') // and the import still happened
  })

  it('still writes nothing at all when the timestamps say only one side moved', async () => {
    // Condition (c) is untouched by this fix. Without lastSyncAt there is no
    // cursor and no claim that the local side moved.
    const { dir, files } = await run(
      [cloudRow('a', T - HOUR, { title: 'renamed over there' })],
      [{ id: 'a', updatedAt: EDITED_HERE, title: 'renamed here' }],
      undefined
    )
    await rm(dir, { recursive: true, force: true })
    expect(files).not.toContain('a.conflict')
  })
})
