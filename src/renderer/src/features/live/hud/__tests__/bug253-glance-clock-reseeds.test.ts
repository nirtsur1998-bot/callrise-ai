// @vitest-environment happy-dom
//
// BUG-253 — switching the HUD back to Glance must not expire a live cue.
//
// `now` inside useGlanceCue has exactly one writer: a 400 ms interval that is
// torn down whenever `enabled` is false (the rep is on the 'Full' layout).
// While disabled the clock is FROZEN. Re-arming the interval without seeding
// `setNow` left the first fresh value 400 ms away, so on the enabling frame
// the hook compared a live cue's TTL against a clock from however long ago the
// layout was switched — and the first tick then jumped `now` forward by that
// whole span, crossing GLANCE_TTL_MS at once. The cue flashed and vanished,
// and the absorption ledger recorded a `shown` AND an `expired` for a cue
// nobody had time to read.
//
// THE LINE ESLINT FLAGGED IS NOT THE ONE UNDER TEST HERE. `react-hooks/refs`
// points at the readyAt stamp; gating that on `enabled` fixes nothing, because
// the enabling render still carries the frozen value. This pins the clock
// seed, which is the actual mechanism. A lint hit is a hypothesis about a
// neighbourhood, not a diagnosis of a line.
//
// The clock is mocked rather than waited on: the defect is defined by a gap of
// more than GLANCE_TTL_MS (20 s), and a test that really slept 20 s would be
// one nobody runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { useGlanceCue } from '../useGlanceCue'
import type { LiveCue } from '../../useLiveCues'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const CUE: LiveCue = {
  id: 1,
  kind: 'objection',
  text: 'They raised price twice.',
  at: 0,
  evidence: { kind: 'heard', quote: 'that is more than we budgeted' },
  source: 'heard'
}

let clock = 1_000
const realNow = performance.now.bind(performance)

beforeEach(() => {
  clock = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  // recordAbsorption writes here; keep it from touching a real store.
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  performance.now = realNow
})

let latest: ReturnType<typeof useGlanceCue> | null = null

/** `segments` stays empty on purpose: with nobody having spoken,
 *  `canDeliverNow` returns true on its first branch, so this test measures the
 *  TTL and nothing else. */
function Probe({ enabled }: { enabled: boolean }): null {
  latest = useGlanceCue(null, [CUE], [], enabled)
  return null
}

async function mount(): Promise<{ root: Root; render: (enabled: boolean) => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async (enabled: boolean): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(Probe, { enabled }))
    })
  }
  return { root, render }
}

describe('BUG-253 — the glance clock is re-seeded when the HUD comes back', () => {
  it('keeps a pending cue across a long spell on the Full layout', async () => {
    const { root, render } = await mount()

    await render(true)
    expect(latest?.cue?.id, 'the cue must be showing before the toggle, or nothing is proven').toBe(
      1
    )

    await render(false) // rep switches to the 'Full' HUD layout
    clock += 60_000 // ...and stays there for a minute, three times the TTL
    await render(true) // back to 'Glance'

    expect(latest?.cue?.id, 'a minute on another layout is not a minute to read the cue').toBe(1)

    // And the frame AFTER the first interval tick — the frame that used to
    // expire it, because `now` jumped by the whole disabled span at once.
    await act(async () => {
      clock += 400
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(latest?.cue?.id, 'the first tick after re-enabling must not expire it either').toBe(1)

    await act(async () => root.unmount())
  })

  it('still expires a cue that really has sat there past its TTL', async () => {
    // The other direction, and the one that stops the fix becoming "never
    // expire anything": time spent WITH the HUD on does count.
    const { root, render } = await mount()
    await render(true)
    expect(latest?.cue?.id).toBe(1)

    await act(async () => {
      clock += 25_000
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(latest?.cue, 'a cue ignored for 25 s while visible is stale').toBeNull()

    await act(async () => root.unmount())
  })

  it('a cue that survives the toggle can STILL expire afterwards', async () => {
    // This is the hole the first version of the fix opened, and it was found by
    // red-checking rather than by reading. That version CLEARED the readyAt
    // stamps on re-enable. The stamp is only taken when a candidate first
    // appears, so with the entry gone and the candidate unchanged nothing
    // re-stamped it, `decision`'s `?? now` fallback returned 0 on every tick,
    // and the cue became immortal — a cue that never expires is a worse bug
    // than one that expires early, because nothing on screen ever looks wrong.
    const { root, render } = await mount()
    await render(true)
    expect(latest?.cue?.id).toBe(1)

    await render(false)
    clock += 60_000
    await render(true)
    expect(latest?.cue?.id, 'survives the toggle').toBe(1)

    // Now leave it visible, untouched, past its TTL.
    await act(async () => {
      clock += 25_000
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(latest?.cue, '25 s VISIBLE after the toggle is still 25 s ignored').toBeNull()

    await act(async () => root.unmount())
  })

  it('the clock is seeded, not merely re-armed', async () => {
    // Reads the value the hook exposes rather than inferring it from the cue:
    // if `now` were still frozen on the enabling frame, this would read the
    // pre-toggle value.
    const { root, render } = await mount()
    await render(true)
    const before = latest?.now
    expect(before).toBe(1_000)

    await render(false)
    clock += 30_000
    await render(true)

    expect(latest?.now, 'the enabling frame must already carry the live clock').toBe(31_000)
    await act(async () => root.unmount())
  })
})
