// BUG-232 — the title backfill's two requirements, both of them the founder's
// words, both of them the kind of thing that is easy to build wrong and
// impossible to notice afterwards:
//
//   "one action, and let me stop partway"
//   "If 20 of 128 fail, I want to see which and why rather than ending with
//    108 titles and no explanation"
//
// The second is not a nicety. An AGGREGATE COUNT is exactly the reporting
// shape that let BUG-227 hide for five weeks — 137 calls quietly untitled and
// nothing anywhere saying which, or why. A clean-up written in that same shape
// would be the bug apologising in its own voice.
import { describe, it, expect, vi } from 'vitest'
import { runTitleBackfill, titleBackfillResultRef } from '../title-backfill'
import type { GenerateTitleResult } from '../call-title'

const candidates = (n: number): { id: string; title: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `call-${i}`, title: `Call · Sep ${i + 1}, 2026` }))

const ok = (): GenerateTitleResult => ({ ok: true, title: 'Acme — Renewal' })

/** A signal that never fires — for the cases that are not about stopping. */
const never = (): AbortSignal => new AbortController().signal

describe('runTitleBackfill', () => {
  it('titles every candidate when everything works', async () => {
    const titleOne = vi.fn(async () => ok())
    const s = await runTitleBackfill(candidates(5), { isAborted: () => false, titleOne, signal: never() })
    expect(s).toEqual({ attempted: 5, titled: 5, failures: [], stoppedEarly: false })
    expect(titleOne).toHaveBeenCalledTimes(5)
  })

  it('STOPS partway when asked, and everything already titled stays titled', async () => {
    let done = 0
    const titleOne = vi.fn(async () => {
      done += 1
      return ok()
    })
    // The rep presses Stop after the third call.
    const s = await runTitleBackfill(candidates(10), {
      isAborted: () => done >= 3,
      titleOne,
      signal: never()
    })
    expect(s.attempted).toBe(3)
    expect(s.titled).toBe(3)
    expect(s.stoppedEarly).toBe(true)
    // and it genuinely stopped — the remaining seven were never attempted,
    // which is the difference between a Stop button and a Hide button.
    expect(titleOne).toHaveBeenCalledTimes(3)
  })

  it('reports WHICH calls failed and WHY, not just how many', async () => {
    const titleOne = vi.fn(async (id: string): Promise<GenerateTitleResult> => {
      if (id === 'call-1')
        return {
          ok: false,
          reason: 'ai-failed',
          detail: 'Gemini says this project has no prepaid credit left'
        }
      if (id === 'call-3') return { ok: false, reason: 'no-transcript' }
      return ok()
    })
    const s = await runTitleBackfill(candidates(5), { isAborted: () => false, titleOne, signal: never() })

    expect(s.attempted).toBe(5)
    expect(s.titled).toBe(3)
    expect(s.failures).toEqual([
      {
        callId: 'call-1',
        callTitle: 'Call · Sep 2, 2026',
        reason: 'ai-failed',
        // The provider's own sentence survives all the way to the summary.
        // "Gemini has no prepaid credit" sends someone to their billing page;
        // "failed" sends them nowhere, which is the whole complaint.
        detail: 'Gemini says this project has no prepaid credit left'
      },
      {
        callId: 'call-3',
        callTitle: 'Call · Sep 4, 2026',
        reason: 'no-transcript',
        detail: undefined
      }
    ])
  })

  it('one failure never abandons the rest of the run', async () => {
    // A rate limit at call 2 of 128 must not cost the other 126.
    const titleOne = vi.fn(async (id: string): Promise<GenerateTitleResult> =>
      id === 'call-1' ? { ok: false, reason: 'ai-failed' } : ok()
    )
    const s = await runTitleBackfill(candidates(6), { isAborted: () => false, titleOne, signal: never() })
    expect(titleOne).toHaveBeenCalledTimes(6)
    expect(s.titled).toBe(5)
  })

  it('a THROWN error is one call failing, not the run failing', async () => {
    const titleOne = vi.fn(async (id: string): Promise<GenerateTitleResult> => {
      if (id === 'call-2') throw new Error('socket hang up')
      return ok()
    })
    const s = await runTitleBackfill(candidates(4), { isAborted: () => false, titleOne, signal: never() })
    expect(s.attempted).toBe(4)
    expect(s.titled).toBe(3)
    expect(s.failures[0]).toMatchObject({ callId: 'call-2', reason: 'ai-failed' })
    expect(s.failures[0].detail).toContain('socket hang up')
  })

  it('reports progress on every item, starting at zero', async () => {
    const seen: Array<[number, number]> = []
    await runTitleBackfill(candidates(3), {
      isAborted: () => false,
      titleOne: async () => ok(),
      signal: never(),
      onProgress: (d, t) => seen.push([d, t])
    })
    // The leading 0/3 matters: without it the bar appears only after the first
    // AI call returns, which on a slow provider reads as "nothing happened".
    expect(seen).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3]
    ])
  })

  // ── FOUNDER REPORT, 2026-09-08: "the stop button doesn't really stop it." ──
  //
  // It was true, and these three cases are the bug. The loop only observed the
  // abort BETWEEN items, and one item is an AI call measured at 55 seconds on a
  // bad fallback chain — so pressing Stop on the first item meant up to a
  // minute of the UI still saying "Naming…", which is indistinguishable from a
  // button that does nothing. The signal now reaches the provider SDK.

  it('the signal reaches the work, so Stop can land INSIDE a slow request', async () => {
    const controller = new AbortController()
    const seen: AbortSignal[] = []
    const titleOne = vi.fn(async (_id: string, opts: { signal: AbortSignal }) => {
      seen.push(opts.signal)
      return ok()
    })
    await runTitleBackfill(candidates(2), {
      isAborted: () => controller.signal.aborted,
      titleOne,
      signal: controller.signal
    })
    // Without this the abort is only ever observed between items, which is the
    // whole complaint.
    expect(seen[0]).toBe(controller.signal)
  })

  it('an abort mid-request stops the run and is NOT recorded as a failed call', async () => {
    const controller = new AbortController()
    const titleOne = vi.fn(async (id: string): Promise<GenerateTitleResult> => {
      if (id === 'call-1') {
        // The rep pressed Stop while this request was in flight; the SDK
        // rejects with an AbortError.
        controller.abort()
        const err = new Error('Request was aborted.')
        err.name = 'AbortError'
        throw err
      }
      return ok()
    })
    const s = await runTitleBackfill(candidates(5), {
      isAborted: () => controller.signal.aborted,
      titleOne,
      signal: controller.signal
    })

    expect(s.stoppedEarly).toBe(true)
    expect(s.titled).toBe(1)
    // The interrupted call is not counted as attempted and NOT listed as a
    // failure. Telling the rep a call "could not be named" when they cancelled
    // it themselves is a false report, and it would be the loudest thing on
    // screen after they pressed Stop.
    expect(s.attempted).toBe(1)
    expect(s.failures).toEqual([])
    // and nothing after it ran
    expect(titleOne).toHaveBeenCalledTimes(2)
  })

  it('an abort that arrives while an item SUCCEEDS still stops the run', async () => {
    // The race: the click lands while a fast request is already returning, so
    // nothing rejects. Checking only at the top of the loop would start one
    // more call after the rep asked for none.
    const controller = new AbortController()
    const titleOne = vi.fn(async (id: string) => {
      if (id === 'call-0') controller.abort()
      return ok()
    })
    const s = await runTitleBackfill(candidates(4), {
      isAborted: () => controller.signal.aborted,
      titleOne,
      signal: controller.signal
    })
    expect(titleOne).toHaveBeenCalledTimes(1)
    expect(s.titled).toBe(1)
    expect(s.stoppedEarly).toBe(true)
  })

  it('does nothing, successfully, when there is nothing to name', async () => {
    const titleOne = vi.fn(async () => ok())
    const s = await runTitleBackfill([], { isAborted: () => false, titleOne, signal: never() })
    expect(s).toEqual({ attempted: 0, titled: 0, failures: [], stoppedEarly: false })
    expect(titleOne).not.toHaveBeenCalled()
  })
})

describe('titleBackfillResultRef — the one line the Activity Center shows', () => {
  it('names the failures rather than only the successes', () => {
    expect(
      titleBackfillResultRef({ attempted: 128, titled: 108, failures: Array(20).fill({}) as never, stoppedEarly: false })
    ).toBe('108 titled, 20 could not be named')
  })

  it('says so when the rep stopped it', () => {
    expect(
      titleBackfillResultRef({ attempted: 30, titled: 30, failures: [], stoppedEarly: true })
    ).toBe('30 titled, stopped early')
  })

  it('stays quiet about failures when there were none', () => {
    expect(
      titleBackfillResultRef({ attempted: 12, titled: 12, failures: [], stoppedEarly: false })
    ).toBe('12 titled')
  })
})
