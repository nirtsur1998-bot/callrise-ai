import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { belongsInFeed, FEED_POLICY_INTERNALS } from '../feedPolicy'
import type { Job, JobLane, JobState } from '../../../../../preload/index.d'

/**
 * The Activity panel is a FEED, not a log.
 *
 * Two of these tests exist because the founder named them as hard constraints
 * rather than preferences, and a constraint without a test is a preference:
 *
 *   1. the rule is STRUCTURAL — "if it's a per-job flag, the first person to
 *      add a job without knowing the convention breaks it"
 *   2. FAILURES ALWAYS SURFACE — "a feed that hides a broken backup because
 *      'the user didn't start it' is worse than the log"
 */

const job = (over: Partial<Job> = {}): Pick<Job, 'lane' | 'state' | 'type'> => ({
  lane: 'MAINTENANCE' as JobLane,
  state: 'succeeded' as JobState,
  type: 'backup',
  ...over
})

const ALL_LANES: JobLane[] = ['LIVE', 'INTERACTIVE', 'BATCH', 'MAINTENANCE']
const ALL_STATES: JobState[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
]

describe('failures always surface (the non-negotiable one)', () => {
  it('shows a FAILED job from every lane, including housekeeping', () => {
    for (const lane of ALL_LANES) {
      expect(belongsInFeed(job({ lane, state: 'failed' })), `${lane} failure was hidden`).toBe(true)
    }
  })

  it('shows an INTERRUPTED job from every lane — Resume lives in this panel', () => {
    for (const lane of ALL_LANES) {
      expect(
        belongsInFeed(job({ lane, state: 'interrupted' })),
        `${lane} interrupted job was hidden, so its Resume button is unreachable`
      ).toBe(true)
    }
  })

  it('shows a broken backup by name — the founder’s own example', () => {
    expect(belongsInFeed({ lane: 'MAINTENANCE', state: 'failed', type: 'backup' })).toBe(true)
  })

  it('the failure check runs BEFORE any lane filtering', () => {
    // Guards the ORDER, not just the outcome. If a future filter is added
    // above the failure check, this is what catches it: LIVE is the one lane
    // hidden unconditionally, so a LIVE failure passing proves the failure
    // check short-circuits first rather than surviving by luck.
    expect(belongsInFeed({ lane: 'LIVE', state: 'failed', type: 'anything' })).toBe(true)
    expect(belongsInFeed({ lane: 'LIVE', state: 'succeeded', type: 'anything' })).toBe(false)
  })
})

describe('the feed rule', () => {
  it('hides routine maintenance that SUCCEEDED', () => {
    for (const type of [
      'backup',
      'cloud-sync',
      'events:reconcile',
      'warm-up-embeddings',
      'nightly-consolidation'
    ]) {
      expect(belongsInFeed(job({ type, state: 'succeeded' })), `${type} was shown`).toBe(false)
    }
  })

  it('shows everything the user started, in every non-terminal state', () => {
    for (const state of ALL_STATES) {
      expect(belongsInFeed(job({ lane: 'INTERACTIVE', state, type: 'summarise' }))).toBe(true)
      expect(belongsInFeed(job({ lane: 'BATCH', state, type: 'generate-tasks' }))).toBe(true)
    }
  })

  it('shows update progress even though it is MAINTENANCE and nobody started it', () => {
    // The founder's explicit carve-out. Pinned in both states that matter:
    // downloading (progress they want to see) and done.
    expect(belongsInFeed({ lane: 'MAINTENANCE', state: 'running', type: 'updater:download' })).toBe(
      true
    )
    expect(
      belongsInFeed({ lane: 'MAINTENANCE', state: 'succeeded', type: 'updater:download' })
    ).toBe(true)
  })
})

describe('the rule is structural, not per-job', () => {
  it('covers every lane exhaustively — a new lane cannot be silently undecided', () => {
    for (const lane of ALL_LANES) {
      expect(
        FEED_POLICY_INTERNALS.LANE_FEED_POLICY[lane],
        `${lane} has no declared feed policy`
      ).toBeDefined()
    }
    expect(Object.keys(FEED_POLICY_INTERNALS.LANE_FEED_POLICY).sort()).toEqual([...ALL_LANES].sort())
  })

  it('an unknown job type in a lane still gets that lane’s behaviour', () => {
    // The founder's actual worry: someone adds a job tomorrow and knows
    // nothing about this file. Filing it in a lane — which they must do
    // anyway, for scheduling — is the whole contract.
    expect(belongsInFeed(job({ lane: 'INTERACTIVE', type: 'a-job-invented-tomorrow' }))).toBe(true)
    expect(belongsInFeed(job({ lane: 'MAINTENANCE', type: 'a-job-invented-tomorrow' }))).toBe(false)
  })

  it('keeps the exception list to exactly what was justified', () => {
    // Exceptions are where a structural rule rots back into a per-job flag.
    // If this fails, either the entry is justified in the file's comment and
    // this number moves deliberately, or the lane table is wrong and should
    // be fixed instead of patched.
    expect([...FEED_POLICY_INTERNALS.FEED_ALWAYS_TYPES]).toEqual(['updater:download'])
  })

  it('the exception names a job type that actually exists', () => {
    // A typo here fails OPEN: the update download silently drops out of the
    // feed and the test still passes, because nothing else checks the string.
    // (This caught a real wrong guess — 'update-download' — while writing it.)
    const updaterSrc = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', 'main', 'updater', 'index.ts'),
      'utf8'
    )
    for (const type of FEED_POLICY_INTERNALS.FEED_ALWAYS_TYPES) {
      expect(updaterSrc, `no job type '${type}' is defined in the updater`).toContain(`'${type}'`)
    }
  })
})

describe('nothing that can fail becomes unfindable', () => {
  it('every lane has SOME state in which its jobs appear', () => {
    // The founder's flag-it condition: "if dropping maintenance from the panel
    // means some jobs become genuinely invisible — no toast, no OS
    // notification, no row anywhere — flag those." Failures keep every lane
    // reachable, so nothing disappears entirely. This is that guarantee,
    // asserted rather than argued.
    for (const lane of ALL_LANES) {
      const visibleIn = ALL_STATES.filter((state) => belongsInFeed(job({ lane, state })))
      expect(visibleIn.length, `${lane} jobs are invisible in EVERY state`).toBeGreaterThan(0)
      expect(visibleIn, `${lane} failures are not visible anywhere`).toContain('failed')
    }
  })
})
