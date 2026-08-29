import { describe, expect, it } from 'vitest'
import { ActivityNotifier, computeTaskbarProgress } from '../activity'
import type { Job, JobLane, JobState } from '../types'

let nextId = 1
function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${nextId++}`,
    type: 'test:type',
    title: 'Test job',
    state: 'queued',
    progress: { mode: 'indeterminate' },
    lane: 'INTERACTIVE',
    priority: 0,
    createdAt: Date.now(),
    cancellable: true,
    input: {},
    ...overrides
  }
}

function withState(job: Job, state: JobState): Job {
  return { ...job, state }
}

// M27 — two expectations in this file were CORRECTED, not relaxed. They were
// written against makeJob()'s default `state: 'queued'` and asserted that a
// merely-QUEUED job announces "Started: X". That was always inaccurate; it
// went unnoticed because queues drained in milliseconds, so the claim was
// only ever briefly wrong. Quota-pressure deferral (JobManager's capacity
// gate) can now hold a background job queued for hours, which would turn that
// into a flatly false toast. The fix moved the announcement to the moment the
// job actually starts running; these tests are updated to assert the real
// guarantee ("a job announces itself exactly once, when it truly begins")
// rather than the old moment. See jobs/__tests__/deferralHonesty.test.ts.
describe('ActivityNotifier — starts', () => {
  it('fires a started event when a job actually begins running, outside a live call', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ title: 'Scanning 143 calls', state: 'running' })
    const events = notifier.next([job])
    expect(events).toEqual([
      { kind: 'started', job, message: 'Started: Scanning 143 calls — track in Activity' }
    ])
  })

  it('never fires (and never buffers) a started event while a live call is active', () => {
    const notifier = new ActivityNotifier()
    const liveCall = makeJob({ lane: 'LIVE', state: 'running' })
    const newJob = makeJob({ title: 'CRM note' })
    const events = notifier.next([liveCall, newJob])
    // Only the live job itself is "new" too, but LIVE-lane jobs never generate
    // activity noise of their own (they ARE the call, not background work about it).
    expect(events.filter((e) => e.kind === 'started')).toEqual([])

    // And it's not queued for later either — ending the call produces no
    // retroactive "by the way, X started" event.
    const laterEvents = notifier.next([withState(liveCall, 'succeeded'), newJob])
    expect(laterEvents.some((e) => e.kind === 'started')).toBe(false)
  })

  it('announces a job exactly once across queued -> running -> running', () => {
    // The guarantee this has always protected — one announcement per job —
    // is unchanged. What moved is WHEN: the queued snapshot is now silent
    // (nothing has started), the transition to running is the single
    // announcement, and staying running never re-fires.
    const notifier = new ActivityNotifier()
    const job = makeJob() // queued
    expect(notifier.next([job])).toEqual([])
    const started = notifier.next([withState(job, 'running')])
    expect(started.filter((e) => e.kind === 'started')).toHaveLength(1)
    expect(notifier.next([withState(job, 'running')])).toEqual([])
  })
})

describe('ActivityNotifier — silent job types', () => {
  // Some features already fire their own, better-worded completion
  // notification (contact auto-attach's "Automatically created and attached
  // 'Dana'"). Migrating those to a job must not silently double up what the
  // rep actually sees.
  it('never fires a started event for a silent job', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ silent: true, title: 'Detecting who this was' })
    expect(notifier.next([job])).toEqual([])
  })

  it('never fires a completion event for a silent job', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ silent: true })
    notifier.next([job])
    expect(notifier.next([withState(job, 'succeeded')])).toEqual([])
    const failing = makeJob({ silent: true })
    notifier.next([failing])
    expect(notifier.next([withState(failing, 'failed')])).toEqual([])
  })

  it('a silent job never lands in the post-call digest either', () => {
    const notifier = new ActivityNotifier()
    const liveCall = makeJob({ lane: 'LIVE', state: 'running' })
    const silent = makeJob({ silent: true, state: 'running' })
    const loud = makeJob({ title: 'Coach this call', state: 'running' })
    notifier.next([liveCall, silent, loud])
    notifier.next([liveCall, withState(silent, 'succeeded'), withState(loud, 'succeeded')])

    const events = notifier.next([
      withState(liveCall, 'succeeded'),
      withState(silent, 'succeeded'),
      withState(loud, 'succeeded')
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('digest')
    if (events[0].kind === 'digest') {
      // Only the loud one — the silent job's own feature already told the rep.
      expect(events[0].jobs).toHaveLength(1)
      expect(events[0].jobs[0].title).toBe('Coach this call')
    }
  })

  it('a non-silent job of the same shape still notifies normally — the flag is doing the work, not something else', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ silent: false, title: 'Detecting who this was' })
    notifier.next([job])
    const events = notifier.next([withState(job, 'succeeded')])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('succeeded')
  })
})

describe('ActivityNotifier — completions outside a call', () => {
  it('fires a succeeded event the moment a job transitions to succeeded', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ title: 'Coach this call' })
    notifier.next([job]) // seen as queued first
    const running = withState(job, 'running')
    notifier.next([running])
    const done = withState(job, 'succeeded')
    const events = notifier.next([done])
    expect(events).toEqual([{ kind: 'succeeded', job: done, message: 'Coach this call — done' }])
  })

  it('fires a failed event with the error message', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ title: 'Generate tasks' })
    notifier.next([job])
    const failed = withState(job, 'failed')
    failed.error = { message: 'No AI key configured' }
    const events = notifier.next([failed])
    expect(events).toEqual([
      { kind: 'failed', job: failed, message: 'Generate tasks — failed: No AI key configured' }
    ])
  })

  it('does not fire again for a job that is already terminal (no duplicate on a later unrelated tick)', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob()
    notifier.next([job])
    const done = withState(job, 'succeeded')
    notifier.next([done])
    const events = notifier.next([done]) // same terminal state again
    expect(events).toEqual([])
  })

  it('never fires for cancelled or interrupted — only succeeded/failed are notification-worthy', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob()
    notifier.next([job])
    const cancelled = notifier.next([withState(job, 'cancelled')])
    expect(cancelled).toEqual([])
    const job2 = makeJob()
    notifier.next([job2])
    const interrupted = notifier.next([withState(job2, 'interrupted')])
    expect(interrupted).toEqual([])
  })
})

describe('ActivityNotifier — call-aware Do-Not-Disturb', () => {
  it('buffers a completion during a live call instead of firing it immediately', () => {
    const notifier = new ActivityNotifier()
    const liveCall = makeJob({ lane: 'LIVE', state: 'running' })
    const bg = makeJob({ title: 'Auto-summarize' })
    notifier.next([liveCall, withState(bg, 'running')])
    const events = notifier.next([liveCall, withState(bg, 'succeeded')])
    expect(events).toEqual([]) // nothing fires yet — the rep is on a call
  })

  it('delivers everything buffered as ONE digest the instant the call ends', () => {
    const notifier = new ActivityNotifier()
    const liveCall = makeJob({ lane: 'LIVE', state: 'running' })
    const jobA = withState(makeJob({ title: 'A' }), 'running')
    const jobB = withState(makeJob({ title: 'B' }), 'running')
    const jobC = withState(makeJob({ title: 'C' }), 'running')

    notifier.next([liveCall, jobA, jobB, jobC])
    notifier.next([liveCall, withState(jobA, 'succeeded'), jobB, jobC]) // buffered
    notifier.next([liveCall, withState(jobA, 'succeeded'), withState(jobB, 'failed'), jobC]) // buffered

    // Call ends — jobC never finished, irrelevant to the digest.
    const events = notifier.next([
      withState(liveCall, 'succeeded'),
      withState(jobA, 'succeeded'),
      withState(jobB, 'failed'),
      jobC
    ])

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('digest')
    expect(events[0].message).toBe(
      'While you were on your call: 1 finished, 1 failed — track in Activity'
    )
    if (events[0].kind === 'digest') {
      expect(events[0].jobs).toHaveLength(2)
    }
  })

  it('produces no digest event at all if nothing finished during the call', () => {
    const notifier = new ActivityNotifier()
    const liveCall = makeJob({ lane: 'LIVE', state: 'running' })
    notifier.next([liveCall])
    const events = notifier.next([withState(liveCall, 'succeeded')])
    expect(events).toEqual([])
  })

  it('a completion right after the call ends (not during it) fires normally, not as a digest', () => {
    const notifier = new ActivityNotifier()
    const liveCall = makeJob({ lane: 'LIVE', state: 'running' })
    const bg = withState(makeJob({ title: 'Post-call brief' }), 'running')
    notifier.next([liveCall, bg])
    notifier.next([withState(liveCall, 'succeeded'), bg]) // call ends, bg still running
    const events = notifier.next([withState(liveCall, 'succeeded'), withState(bg, 'succeeded')])
    expect(events).toEqual([
      { kind: 'succeeded', job: withState(bg, 'succeeded'), message: 'Post-call brief — done' }
    ])
  })

  it('a second, later call correctly buffers again (DND state is not "used up")', () => {
    const notifier = new ActivityNotifier()
    const call1 = makeJob({ lane: 'LIVE', state: 'running' })
    const jobA = withState(makeJob(), 'running')
    notifier.next([call1, jobA])
    notifier.next([withState(call1, 'succeeded'), withState(jobA, 'succeeded')]) // digest 1

    const call2 = makeJob({ lane: 'LIVE', state: 'running' })
    const jobB = withState(makeJob(), 'running')
    notifier.next([call2, jobB])
    const events = notifier.next([call2, withState(jobB, 'succeeded')])
    expect(events).toEqual([]) // buffered again for call 2, not leaked from call 1's already-flushed state
  })
})

describe('computeTaskbarProgress', () => {
  const LANE: JobLane = 'BATCH'

  it('clears the bar when nothing is running', () => {
    expect(computeTaskbarProgress([])).toEqual({ progress: -1 })
    expect(computeTaskbarProgress([makeJob({ lane: LANE, state: 'succeeded' })])).toEqual({
      progress: -1
    })
  })

  it('reports a real aggregate fraction when every running job is determinate', () => {
    const jobs = [
      makeJob({
        lane: LANE,
        state: 'running',
        progress: { mode: 'determinate', itemsDone: 5, itemsTotal: 10 }
      }),
      makeJob({
        lane: LANE,
        state: 'running',
        progress: { mode: 'determinate', itemsDone: 1, itemsTotal: 4 }
      })
    ]
    // (5+1) / (10+4) — summed, not averaged, so a small job doesn't count
    // equally against a much larger one.
    expect(computeTaskbarProgress(jobs)).toEqual({ progress: 6 / 14 })
  })

  it('goes indeterminate the instant ANY running job lacks real progress', () => {
    const jobs = [
      makeJob({
        lane: LANE,
        state: 'running',
        progress: { mode: 'determinate', itemsDone: 5, itemsTotal: 10 }
      }),
      makeJob({
        lane: LANE,
        state: 'running',
        progress: { mode: 'stages', stageLabel: 'Analyzing' }
      })
    ]
    expect(computeTaskbarProgress(jobs)).toEqual({ progress: 1, mode: 'indeterminate' })
  })

  it('is indeterminate when the only running jobs are indeterminate/staged', () => {
    const jobs = [makeJob({ lane: LANE, state: 'running', progress: { mode: 'indeterminate' } })]
    expect(computeTaskbarProgress(jobs)).toEqual({ progress: 1, mode: 'indeterminate' })
  })

  it('ignores queued/succeeded/failed jobs — only RUNNING jobs count toward the bar', () => {
    const jobs = [
      makeJob({ lane: LANE, state: 'queued' }),
      makeJob({
        lane: LANE,
        state: 'succeeded',
        progress: { mode: 'determinate', itemsDone: 9, itemsTotal: 9 }
      }),
      makeJob({
        lane: LANE,
        state: 'running',
        progress: { mode: 'determinate', itemsDone: 3, itemsTotal: 6 }
      })
    ]
    expect(computeTaskbarProgress(jobs)).toEqual({ progress: 0.5 })
  })
})

// BUG-129 — "it launches 10-20 notifications and it's crazy". Launch fires a
// burst of MAINTENANCE jobs (on-device search setup, sign-in cloud sync,
// backup, update check, Sales Brain tidy-up). Each completion used to raise a
// toast and, whenever the window was unfocused — which is the normal case at
// startup — an OS popup too.
//
// The rule pinned here is the founder-approved attention policy, both halves:
// successful maintenance says NOTHING, and failing maintenance still says
// something exactly once. The second half matters as much as the first: a
// backup that silently stops working is the failure mode this project has
// spent months eliminating, and it would be trivially easy to "fix" the spam
// by silencing the lane wholesale.
describe('ActivityNotifier — maintenance is quiet about success, never about failure', () => {
  it('says nothing when a maintenance job starts', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ lane: 'MAINTENANCE', title: 'Backing up to the cloud', state: 'running' })
    expect(notifier.next([job])).toEqual([])
  })

  it('says nothing when a maintenance job succeeds', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ lane: 'MAINTENANCE', title: 'Setting up on-device search', state: 'running' })
    notifier.next([job])
    expect(notifier.next([withState(job, 'succeeded')])).toEqual([])
  })

  it('says nothing for a maintenance job that begins and succeeds inside one snapshot', () => {
    // The coalesced path: a fast job first seen already terminal. This is the
    // one launch-time jobs most often take, since they finish quickly.
    const notifier = new ActivityNotifier()
    const job = makeJob({ lane: 'MAINTENANCE', title: 'Syncing with the cloud', state: 'succeeded' })
    expect(notifier.next([job])).toEqual([])
  })

  it('STILL reports a maintenance job that fails', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ lane: 'MAINTENANCE', title: 'Backing up to the cloud', state: 'running' })
    notifier.next([job])
    const events = notifier.next([withState(job, 'failed')])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('failed')
  })

  it('STILL reports a maintenance job that fails inside one snapshot', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ lane: 'MAINTENANCE', title: 'Backing up to the cloud', state: 'failed' })
    const events = notifier.next([job])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('failed')
  })

  it('leaves every other lane exactly as loud as it was', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ lane: 'BATCH', title: 'Scanning 143 calls', state: 'running' })
    expect(notifier.next([job])).toHaveLength(1) // started
    expect(notifier.next([withState(job, 'succeeded')])).toHaveLength(1) // completed
  })

  it('silences a whole launch burst rather than merely thinning it', () => {
    // The actual reported symptom, as a single assertion: five maintenance
    // jobs completing together produce zero notifications.
    const notifier = new ActivityNotifier()
    const burst: Job[] = [
      'Setting up on-device search',
      'Syncing with the cloud',
      'Backing up to the cloud',
      'Downloading update',
      'Sales Brain: nightly tidy-up'
    ].map((title) => makeJob({ lane: 'MAINTENANCE', title, state: 'succeeded' }))
    expect(notifier.next(burst)).toEqual([])
  })
})
