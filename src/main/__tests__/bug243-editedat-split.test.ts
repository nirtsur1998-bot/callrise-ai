// BUG-243 — `updatedAt` meant two things at once, and the second one lost.
//
// It is the SYNC ORDERING KEY (the server trigger accepts only strictly-newer
// rows) and it was also "when the user last changed this". So when the
// transcripts scrub bumps every call to evict the old transcript-bearing rows
// — correct, load-bearing behaviour — it also erases the modification history
// of the entire corpus. Measured on the founder's store: all 196 live records
// carried the same stamp, inside 789 milliseconds.
//
// `editedAt` now carries the second meaning. ABSENT on every existing record
// and deliberately not backfilled, per the founder: "An absent field is
// honest; a backfilled one is a lie with a timestamp."
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  saveCall,
  setCallTitle,
  touchAllCallsForRepush,
  CALL_FIELD_RULES,
  type Call,
  type CallSegment
} from '../calls-fs'

const segments: CallSegment[] = [{ speaker: 0, text: 'hello', role: 'rep' }]

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'editedat-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const onDisk = (): Call => {
  const f = readdirSync(dir).filter((x) => x.endsWith('.json'))
  expect(f).toHaveLength(1)
  return JSON.parse(readFileSync(join(dir, f[0]), 'utf8'))
}

async function aCall(): Promise<Call> {
  await saveCall(dir, { startedAt: '2026-09-01T10:00:00.000Z', durationMs: 1000, segments })
  return onDisk()
}

describe('BUG-243 — the sync key and the edit stamp are separate clocks', () => {
  it('a fresh call has no editedAt: saving is not editing', async () => {
    const call = await aCall()
    expect(call.updatedAt).toBe(call.createdAt)
    // Absent legitimately means "saved and never edited" — and for those,
    // createdAt is the answer and is intact.
    expect(call.editedAt).toBeUndefined()
  })

  it('a real edit stamps BOTH', async () => {
    const call = await aCall()
    await setCallTitle(dir, call.id, 'Renamed by hand')
    const after = onDisk()
    expect(after.title).toBe('Renamed by hand')
    expect(after.editedAt).toBeTruthy()
    // Taken from one value, so they cannot land a millisecond apart and read
    // as two separate events later.
    expect(after.editedAt).toBe(after.updatedAt)
  })

  it('THE SCRUB REPUSH MOVES ONLY THE SYNC KEY — the whole point', async () => {
    const call = await aCall()
    await setCallTitle(dir, call.id, 'Renamed by hand')
    const edited = onDisk()

    await touchAllCallsForRepush(dir)
    const after = onDisk()

    // RED-CHECK: make touchAllCallsForRepush use touchCall() and this fails —
    // which is exactly the conflation that flattened 196 records.
    expect(after.editedAt, 'a repush must not look like an edit').toBe(edited.editedAt)
    expect(
      Date.parse(after.updatedAt),
      'the repush must still move the sync key, or the scrub cannot evict the old rows'
    ).toBeGreaterThanOrEqual(Date.parse(edited.updatedAt))
  })

  it('a call written before the field existed keeps NO editedAt', async () => {
    // Not backfilled, on purpose. A fabricated date is worse than an absent
    // one: it reads as evidence later.
    const call = await aCall()
    const legacy = { ...call }
    delete (legacy as Partial<Call>).editedAt
    writeFileSync(join(dir, `${call.id}.json`), JSON.stringify(legacy), 'utf8')

    await touchAllCallsForRepush(dir)
    expect(onDisk().editedAt, 'a repush invented an edit date for a legacy record').toBeUndefined()
  })

  it('is classified as METADATA — a clock reading about the record', () => {
    expect(CALL_FIELD_RULES.editedAt).toEqual({ cls: 'METADATA' })
  })
})
