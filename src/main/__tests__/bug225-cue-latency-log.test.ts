// BUG-225 — the cue latency instrument now has a destination.
//
// The instrument was always right. Its report went into React state, nothing
// read it, and `reset()` destroyed the samples at the call boundary — so the
// only cue-latency figures that existed anywhere were TARGETS (the 6,000 ms
// budget, the 10,000 ms ceiling). There was no measured p50 or p95 on any
// machine, ever, which is why this is BUG-222's prerequisite rather than a
// side note: "it did not get slower" and "it did" were equally unfalsifiable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dataDir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

const { poolStats, sanitiseEntry, percentile, appendCueLatency, readCueLatencyEntries } =
  await import('../live/cue-latency-log')

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bug225-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const logLines = (): string[] =>
  readFileSync(join(dataDir, 'cue-latency.jsonl'), 'utf8').split('\n').filter(Boolean)

const entry = (deterministic: number[], model: number[] = [], callId = 'c1'): never =>
  ({ ts: '2026-09-10T00:00:00.000Z', callId, samples: { deterministic, model } }) as never

describe('BUG-225 — pooled, because a percentile of percentiles is not a percentile', () => {
  it('weights a call by how many cues it actually produced', () => {
    // One 200-cue call, all fast. One 2-cue call, both catastrophic.
    // Averaging the two calls' p95 values would report ~5000ms and imply the
    // product is broken. Pooling reports the truth: 202 samples, and the slow
    // pair sits in the tail where a p95 is supposed to find it.
    const fast = Array.from({ length: 200 }, () => 400)
    const slow = [9000, 9500]
    const pooled = poolStats([entry(fast, [], 'busy'), entry(slow, [], 'quiet')], 'deterministic')

    expect(pooled.calls).toBe(2)
    expect(pooled.count).toBe(202)
    expect(pooled.p50).toBe(400) // the common experience, not the mean of two calls
    expect(pooled.max).toBe(9500) // and the tail is still visible
    // The wrong method, stated so the difference is on the record:
    const perCallP95Mean = (percentile([...fast].sort((a, b) => a - b), 95)! + percentile(slow, 95)!) / 2
    expect(perCallP95Mean).toBeGreaterThan(4000)
    expect(pooled.p95!).toBeLessThan(perCallP95Mean)
  })

  it('keeps the two tiers apart — they are different questions', () => {
    // A deterministic phrase match (~400ms) and a model completion (~2s) in one
    // bucket would quote the fast number for the slow thing.
    const e = entry([400, 420], [2100, 2300])
    expect(poolStats([e], 'deterministic').p50).toBe(400)
    expect(poolStats([e], 'model').p50).toBe(2100)
  })

  it('reports nulls rather than zeros when there is nothing to say', () => {
    const s = poolStats([], 'model')
    expect(s).toMatchObject({ calls: 0, count: 0, p50: null, p95: null, max: null })
  })

  it('every reported number is a latency that genuinely occurred', () => {
    // Nearest-rank, matching the instrument: an interpolated percentile invents
    // a value nobody experienced, which is the wrong property for a figure this
    // project intends to publish.
    const s = poolStats([entry([100, 200, 300])], 'deterministic')
    for (const v of [s.p50, s.p95, s.max]) expect([100, 200, 300]).toContain(v)
  })
})

describe('BUG-225 — the IPC boundary is not trusted', () => {
  it('drops a call that produced no cues, so it cannot dilute an aggregate', () => {
    expect(sanitiseEntry({ callId: 'c1', samples: { deterministic: [], model: [] } })).toBeNull()
  })

  it('discards nonsense values instead of poisoning the percentiles', () => {
    const e = sanitiseEntry({
      callId: 'c1',
      samples: { deterministic: [100, -5, Number.NaN, 'x', Infinity, 200], model: null }
    })
    expect(e?.samples.deterministic).toEqual([100, 200])
    expect(e?.samples.model).toEqual([])
  })

  it('accepts a null callId — a call stopped before it was saved still measured cues', () => {
    expect(sanitiseEntry({ callId: null, samples: { deterministic: [100], model: [] } })?.callId).toBeNull()
  })

  it('refuses a callId that is not a short string', () => {
    const e = sanitiseEntry({ callId: 'x'.repeat(500), samples: { deterministic: [100], model: [] } })
    expect(e?.callId).toBeNull()
  })
})

describe('BUG-225 — one line per call, though a call flushes more than once', () => {
  // The renderer flushes at every point the samples stop being replaceable,
  // and a single call hits several: a capture blip drops `active` and brings
  // it back, the screen can remount. Each flush carries only what was measured
  // since the last one. Appending each would keep the samples right and the
  // CALL COUNT wrong — and the call count is the denominator a reader uses to
  // decide whether a percentile is worth believing.
  it('merges a second flush of the same call into the line already there', async () => {
    await appendCueLatency(entry([400], [2000], 'call-A'))
    await appendCueLatency(entry([420, 450], [2200], 'call-A'))

    expect(logLines()).toHaveLength(1)
    const [e] = await readCueLatencyEntries()
    expect(e.samples.deterministic).toEqual([400, 420, 450])
    expect(e.samples.model).toEqual([2000, 2200])
    expect(poolStats([e], 'deterministic').calls).toBe(1)
  })

  it('keeps the call’s FIRST timestamp — the line describes when the call happened', async () => {
    await appendCueLatency({
      ts: '2026-09-10T09:00:00.000Z',
      callId: 'call-A',
      samples: { deterministic: [400], model: [] }
    })
    await appendCueLatency({
      ts: '2026-09-10T09:31:00.000Z',
      callId: 'call-A',
      samples: { deterministic: [410], model: [] }
    })
    // The length assertion is load-bearing, not decoration: with the merge
    // disabled the file holds two lines and `entries[0].ts` is STILL the first
    // flush's, so a test that only read [0] passed either way. Caught by the
    // red-check — it fired on the sibling test and not on this one.
    const entries = await readCueLatencyEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].ts).toBe('2026-09-10T09:00:00.000Z')
  })

  it('starts a new line for a different call', async () => {
    await appendCueLatency(entry([400], [], 'call-A'))
    await appendCueLatency(entry([500], [], 'call-B'))
    expect(logLines()).toHaveLength(2)
    expect(poolStats(await readCueLatencyEntries(), 'deterministic').calls).toBe(2)
  })

  it('merges only into the LAST line, never a matching one further back', async () => {
    // Calls are sequential. Searching the file would let an id recycled days
    // ago absorb today's samples into a line with today's numbers under an old
    // timestamp — quietly wrong, and invisible.
    await appendCueLatency(entry([400], [], 'call-A'))
    await appendCueLatency(entry([500], [], 'call-B'))
    await appendCueLatency(entry([600], [], 'call-A'))
    expect(logLines()).toHaveLength(3)
  })

  it('never merges an unsaved call, because null is not an identity', async () => {
    // callId is null for a call stopped before it was saved. Two of those are
    // two different calls; merging them on "both null" would fuse strangers.
    await appendCueLatency(entry([400], [], null as unknown as string))
    await appendCueLatency(entry([500], [], null as unknown as string))
    expect(logLines()).toHaveLength(2)
  })

  it('survives a torn last line instead of losing the write', async () => {
    writeFileSync(join(dataDir, 'cue-latency.jsonl'), '{"ts":"2026-09-10T09:00:00.000Z","cal\n')
    await appendCueLatency(entry([400], [], 'call-A'))
    const entries = await readCueLatencyEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].samples.deterministic).toEqual([400])
  })
})
