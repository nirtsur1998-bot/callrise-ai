// BUG-248 — the record stores read a whole directory at once. This proves the
// helper that bounds them actually bounds them, preserves order, and does not
// change what the stores return.
//
// The load-bearing assertion is the PEAK CONCURRENCY one. "It's bounded" is
// exactly the kind of claim that a test can appear to check while checking
// nothing: a helper that ignored its limit entirely would still return the
// right values in the right order and pass every other test in this file.
// Red-checked by making mapWithConcurrency call `Promise.all` over everything
// (i.e. reverting to the old behaviour): peak concurrency goes 8 -> 50 (and the
// default arm 16 -> 50), and only the three bounding tests fail. See BUG-248.
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapWithConcurrency, DEFAULT_READ_CONCURRENCY } from '../bounded-map'

/** Runs `fn` over 0..n-1 while tracking how many were ever in flight at once. */
async function withPeak(n: number, limit?: number): Promise<{ peak: number; results: number[] }> {
  let inFlight = 0
  let peak = 0
  const results = await mapWithConcurrency(
    Array.from({ length: n }, (_, i) => i),
    async (i) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // Yield across a macrotask so every started worker is genuinely
      // overlapping — a microtask-only await would let a broken
      // implementation look bounded.
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return i * 2
    },
    limit
  )
  return { peak, results }
}

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` at once — the whole point', async () => {
    const { peak } = await withPeak(50, 8)
    expect(peak).toBeLessThanOrEqual(8)
    // And it actually uses the budget rather than serialising, which would be
    // "bounded" in a useless way.
    expect(peak).toBe(8)
  })

  it('honours a limit of 1 — fully serial', async () => {
    const { peak } = await withPeak(10, 1)
    expect(peak).toBe(1)
  })

  it('defaults to 16 — the measured knee, not a rule of thumb', async () => {
    const { peak } = await withPeak(50)
    expect(DEFAULT_READ_CONCURRENCY).toBe(16)
    expect(peak).toBe(16)
  })

  it('never exceeds the item count when the limit is larger', async () => {
    const { peak } = await withPeak(3, 8)
    expect(peak).toBe(3)
  })

  it('returns results in INPUT order, not completion order', async () => {
    // Deliberately finish backwards: item 0 is slowest.
    const out = await mapWithConcurrency(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      async (i) => {
        await new Promise((r) => setTimeout(r, (10 - i) * 2))
        return `item-${i}`
      },
      4
    )
    expect(out).toEqual([
      'item-0',
      'item-1',
      'item-2',
      'item-3',
      'item-4',
      'item-5',
      'item-6',
      'item-7',
      'item-8',
      'item-9'
    ])
  })

  it('an empty list does no work and returns []', async () => {
    let called = 0
    const out = await mapWithConcurrency(
      [],
      async () => {
        called += 1
        return 1
      },
      8
    )
    expect(out).toEqual([])
    expect(called).toBe(0)
  })

  it('propagates a rejection the way Promise.all would', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], async (i) => {
        if (i === 2) throw new Error('boom')
        return i
      })
    ).rejects.toThrow('boom')
  })
})

describe('the stores read the same records after bounding', () => {
  it('listTasks returns every task, unchanged, over more files than the limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bounded-map-store-'))
    try {
      const { listTasks, createTask } = await import('../tasks-fs')
      // 30 records against a limit of 16 — two full rounds of the pool.
      for (let i = 0; i < 30; i++) await createTask(dir, { title: `task ${i}` })
      // A stray non-JSON file, because the filter runs before the bounded map
      // and the two must not have got out of step.
      await writeFile(join(dir, 'notes.txt'), 'ignore me', 'utf8')

      const tasks = await listTasks(dir)
      expect(tasks).toHaveLength(30)
      expect(new Set(tasks.map((t) => t.title)).size).toBe(30)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
