// BUG-178 — the instrument M33 needed and the app did not have.
//
// `durationMs` is what the app BELIEVES a call lasted. Nothing anywhere
// recorded what the clock said, so "does recorded duration disagree with
// elapsed time?" — the obvious test of a live-capture hypothesis — could not
// be answered from a single saved call. Three substitutes were tried and all
// three were wrong: updatedAt is last-touched, file mtime is sync time, and
// segments carry no timestamps at all.
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  saveCall,
  importCall,
  keepLocalCallFields,
  CALL_FIELD_RULES,
  type CallSegment
} from '../calls-fs'

const segments: CallSegment[] = [
  { speaker: 0, text: 'thanks for the time today', role: 'rep' },
  { speaker: 1, text: 'no problem at all', role: 'other' }
]

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'endedat-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const readOnly = (): Record<string, unknown> => {
  const f = readdirSync(dir).filter((x) => x.endsWith('.json'))
  expect(f).toHaveLength(1)
  return JSON.parse(readFileSync(join(dir, f[0]), 'utf8'))
}

describe('BUG-178 — endedAt makes elapsed time comparable to claimed duration', () => {
  it('persists the wall-clock end the renderer sent', async () => {
    const startedAt = '2026-09-02T07:28:00.000Z'
    const endedAt = '2026-09-02T07:33:42.000Z' // the real 5m42s call
    await saveCall(dir, { startedAt, durationMs: 342_000, endedAt, segments })
    const call = readOnly()
    expect(call.endedAt).toBe(endedAt)

    // The whole point: elapsed and claimed can now be compared.
    const elapsedMs = Date.parse(call.endedAt as string) - Date.parse(call.createdAt as string)
    expect(elapsedMs).toBe(342_000)
    expect(elapsedMs / (call.durationMs as number)).toBe(1)
  })

  it('a 2x disagreement is VISIBLE — the test that could not be run before', async () => {
    // A call the app thinks ran 5m42s but whose clock says 11m24s: exactly the
    // shape the mono-worklet hypothesis predicts, and previously unmeasurable.
    await saveCall(dir, {
      startedAt: '2026-09-02T07:28:00.000Z',
      durationMs: 342_000,
      endedAt: '2026-09-02T07:39:24.000Z',
      segments
    })
    const call = readOnly()
    const ratio =
      (Date.parse(call.endedAt as string) - Date.parse(call.createdAt as string)) /
      (call.durationMs as number)
    expect(ratio).toBe(2)
  })

  it('falls back to its own clock when the renderer sends nothing', async () => {
    const before = Date.now()
    await saveCall(dir, { startedAt: new Date().toISOString(), durationMs: 1000, segments })
    const call = readOnly()
    expect(typeof call.endedAt).toBe('string')
    const t = Date.parse(call.endedAt as string)
    expect(Number.isNaN(t)).toBe(false)
    expect(t).toBeGreaterThanOrEqual(before - 1000)
  })

  it('falls back rather than storing garbage when the value is unparseable', async () => {
    await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      endedAt: 'not a date',
      segments
    })
    const call = readOnly()
    expect(call.endedAt).not.toBe('not a date')
    expect(Number.isNaN(Date.parse(call.endedAt as string))).toBe(false)
  })

  it('is classified as METADATA — a clock reading carries no speech', () => {
    expect(CALL_FIELD_RULES.endedAt).toEqual({ cls: 'METADATA' })
  })
})

// ---------------------------------------------------------------------------
// BUG-242 — and what the five tests above could not see.
//
// Every case above is a test of the WRITER, and all five pass. On the founder's
// machine `endedAt` was absent on 196 of 196 live calls, including calls saved
// days after the field shipped — while `saveCall` set it unconditionally, with
// a fallback that cannot produce undefined. The field was not failing to be
// born. It was being DELETED, by `importCall`'s restore-merge, which rebuilt
// the record field by field from a list that did not mention it.
//
// A field has a lifetime, not just a birth. Testing the write and not the
// round trip proves the narrower claim ("saveCall records it") while the
// broader one on the tin ("the app records it") is false in production.
describe('BUG-242 — local-only fields survive a restore-merge', () => {
  const cloudRow = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    // Exactly what callBackupPayload sends: no endedAt, no salesBrainExcluded,
    // none of the M23 fields. Its silence about them is not a delete.
    id,
    title: 'Call',
    createdAt: '2026-09-02T07:28:00.000Z',
    updatedAt: '2026-09-09T12:59:16.000Z', // newer, as a real pull would be
    durationMs: 342_000,
    speakerCount: 2,
    preview: '',
    segments: [],
    consent: { status: 'consented', recordOtherParty: true },
    ...over
  })

  it('keeps endedAt when a newer cloud row never carried it', async () => {
    const endedAt = '2026-09-02T07:33:42.000Z'
    await saveCall(dir, {
      startedAt: '2026-09-02T07:28:00.000Z',
      durationMs: 342_000,
      endedAt,
      segments
    })
    const id = readOnly().id as string

    const merged = await importCall(dir, cloudRow(id))
    expect(merged).not.toBeNull()
    // The regression, stated as the founder would read it: the clock reading
    // is still there after the sync that has been eating it since 2026-09-02.
    expect(readOnly().endedAt).toBe(endedAt)
  })

  it('keeps every KEEP_LOCAL field, enumerated from the table not from memory', async () => {
    await saveCall(dir, {
      startedAt: '2026-09-02T07:28:00.000Z',
      durationMs: 342_000,
      endedAt: '2026-09-02T07:33:42.000Z',
      segments
    })
    const id = readOnly().id as string

    // Set every local-only field the type has. Enumerating from
    // CALL_RESTORE_RULES' own KEEP_LOCAL set is the point: a field added later
    // fails to compile in the source, and lands here without an edit.
    const local = {
      ...(readOnly() as Record<string, unknown>),
      callType: 'discovery',
      salesBrainExcluded: true,
      commitments: [], // the honest zero — a real state, not "never ran"
      coachChat: [],
      dealIntelligence: { stage: 'qualified', updatedAt: '2026-09-02T08:00:00.000Z' },
      notes: 'rep typed this',
      crmNoteGeneratedAt: '2026-09-02T08:01:00.000Z'
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(local), 'utf8')

    const before = keepLocalCallFields(local as never)
    expect(Object.keys(before).sort()).toEqual([
      'callType',
      'coachChat',
      'commitments',
      'crmNoteGeneratedAt',
      'dealIntelligence',
      'endedAt',
      'notes',
      'salesBrainExcluded'
    ])

    await importCall(dir, cloudRow(id))
    const after = readOnly()
    for (const [key, value] of Object.entries(before)) {
      expect({ key, value: after[key] }).toEqual({ key, value })
    }
  })

  it('a tombstone keeps none of them — a deleted call retains no local state', async () => {
    await saveCall(dir, {
      startedAt: '2026-09-02T07:28:00.000Z',
      durationMs: 342_000,
      endedAt: '2026-09-02T07:33:42.000Z',
      segments
    })
    const id = readOnly().id as string
    await importCall(dir, cloudRow(id, { deleted: true }))
    const after = readOnly()
    expect(after.deleted).toBe(true)
    expect(after.endedAt).toBeUndefined()
    expect(after.notes).toBeUndefined()
  })
})
