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

describe('ActivityNotifier — starts', () => {
  it('fires a started event for a brand-new job outside a live call', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob({ title: 'Scanning 143 calls' })
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

  it('does not re-fire a started event for a job already seen (e.g. queued -> running)', () => {
    const notifier = new ActivityNotifier()
    const job = makeJob()
    notifier.next([job])
    const events = notifier.next([withState(job, 'running')])
    expect(events).toEqual([])
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
