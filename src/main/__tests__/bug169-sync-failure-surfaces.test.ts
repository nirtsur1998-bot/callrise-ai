// BUG-169 — a calendar push that fails must SURFACE, and must not retry itself.
//
// schedulePush's own comment justified not making the push a background job
// partly because "a failure already surfaces ON THE EVENT ITSELF in the
// Calendar UI via sync.state". That surface was never built: across the entire
// renderer, `sync` and `lastError` appeared exactly once — a type declaration.
// Nothing read either. So a push that 403s, hits a dead token or takes a Graph
// 500 left the event looking completely normal in CallRise while it was absent
// from the rep's real calendar and their phone, and no reminder fired. They
// found out by missing the meeting.
//
// Founder's decision, 2026-09-02: "surface where I'd look: on the event
// itself, and once in the Activity feed as a failure. Failures always surface,
// per the feed rule we already set. Retry manually, don't auto-retry
// silently."
//
// This file pins the two halves that live in main: the non-transient class is
// no longer auto-retried, and it raises a feed job. The on-event marker is a
// renderer change this repo cannot render-test (BUG-140) and is verified by
// reading MonthGrid/WeekGrid here instead of asserting nothing at all.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const events = readFileSync(join(process.cwd(), 'src/main/events.ts'), 'utf8')
const monthGrid = readFileSync(
  join(process.cwd(), 'src/renderer/src/features/calendar/MonthGrid.tsx'),
  'utf8'
)
const weekGrid = readFileSync(
  join(process.cwd(), 'src/renderer/src/features/calendar/WeekGrid.tsx'),
  'utf8'
)

describe('BUG-169 — a failed calendar push surfaces and waits for the rep', () => {
  it('reconcile no longer auto-retries the non-transient class', () => {
    // The old loop retried 'error' forever except the one 'forbidden' case.
    expect(events).toContain("if (state === 'error') continue")
    expect(events).not.toContain("state === 'deleted' || state === 'dirty' || state === 'error'")
  })

  it('CONTROL — the RETRYABLE class is still auto-retried, because that is correct', () => {
    // 'dirty' is offline or a transient 5xx: reconcile should pick it up and
    // there is nothing for the rep to act on. Surfacing it would be noise.
    expect(events).toContain("state === 'deleted' || state === 'dirty'")
  })

  it('raises a feed job only for the non-retryable class', () => {
    expect(events).toContain('if (!res.retryable) reportPushFailure(id, res.error)')
  })

  it('the feed job is NOT silent — being seen is the whole point', () => {
    const block = events.slice(events.indexOf('PUSH_FAILED_JOB_TYPE,'))
    const registration = block.slice(0, block.indexOf('RECONCILE_JOB_TYPE'))
    expect(registration).toContain('silent: false')
  })

  it('reports ONCE per event, not once per attempt', () => {
    // An edit loop or a reconcile pass can call schedulePush repeatedly for the
    // same event. A feed that fills with the same failure is one the rep learns
    // to scroll past — which recreates the original silence with extra steps.
    expect(events).toContain("j.state === 'queued' || j.state === 'running' || j.state === 'failed'")
  })

  it('the event itself carries the failure, in both calendar views', () => {
    for (const [name, src] of [
      ['MonthGrid', monthGrid],
      ['WeekGrid', weekGrid]
    ] as const) {
      expect(src, name + ' does not read sync.state').toContain("item.event?.sync?.state === 'error'")
      expect(src, name + ' does not say what it means').toContain('NOT on your real calendar')
    }
  })

  it('CONTROL — the views do NOT flag the retryable class', () => {
    // Marking 'dirty' would put a warning on every event while offline.
    for (const src of [monthGrid, weekGrid]) {
      expect(src).not.toContain("sync?.state === 'dirty'")
    }
  })
})
