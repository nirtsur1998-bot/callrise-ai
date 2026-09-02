// BUG-178 — the instrument M33 needed and the app did not have.
//
// `durationMs` is what the app BELIEVES a call lasted. Nothing anywhere
// recorded what the clock said, so "does recorded duration disagree with
// elapsed time?" — the obvious test of a live-capture hypothesis — could not
// be answered from a single saved call. Three substitutes were tried and all
// three were wrong: updatedAt is last-touched, file mtime is sync time, and
// segments carry no timestamps at all.
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCall, CALL_FIELD_RULES, type CallSegment } from '../calls-fs'

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
