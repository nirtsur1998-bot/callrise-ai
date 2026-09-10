// BUG-258 — the headline must count what is USABLE, not what was collected.
//
// The old line was "N new things learned this week", counting creations
// regardless of status, and it rendered only when N > 0. Measured on the
// founder's profile: 73 memories, 0 usable, every compiled profile empty, all
// six consumers reading ''. The screen said the Brain was working the whole
// time. These tests pin the states that were previously indistinguishable.
import { describe, expect, it } from 'vitest'
import { summariseUsability, distinctEpisodes, PROMOTION_THRESHOLD_EPISODES } from '../memoryUsability'
import type { Memory } from '../../../../../preload/index.d'

const mem = (over: Partial<Memory>): Memory =>
  ({
    id: Math.random().toString(36).slice(2),
    scope: 'rep',
    category: 'style',
    statement: 'x',
    evidence: [],
    confidence: 0.8,
    importance: 0.5,
    status: 'hypothesis',
    source: 'auto',
    pinned: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastConfirmedAt: '2026-09-01T00:00:00.000Z',
    ...over
  }) as Memory

const withCalls = (...callIds: string[]): Partial<Memory> => ({
  evidence: callIds.map((callId) => ({ type: 'transcript', callId })) as Memory['evidence']
})

describe('BUG-258 — the state the old headline could not express', () => {
  it('says NONE ARE IN USE when nothing has been promoted', () => {
    // The founder's actual profile shape: plenty learned, nothing usable.
    const memories = Array.from({ length: 73 }, () => mem(withCalls('call-1')))
    const s = summariseUsability(memories)

    expect(s.total).toBe(73)
    expect(s.usable).toBe(0)
    expect(s.waiting).toBe(73)
    expect(s.headline).toContain('73 learned')
    expect(s.headline).toContain('none in use')
    // And it must say what would CHANGE it. A broken number with no next step
    // is only marginally better than a wrong one.
    expect(s.detail).toContain(`${PROMOTION_THRESHOLD_EPISODES} separate calls`)
    expect(s.detail).toContain('2 more')
  })

  it('names the features that are NOT seeing the facts', () => {
    // "Not in use" is abstract; the point is that summaries, coaching, chat and
    // live cues are all reading an empty string.
    const s = summariseUsability([mem(withCalls('c1'))])
    for (const feature of ['summaries', 'coaching', 'chat', 'live cues']) {
      expect(s.detail).toContain(feature)
    }
  })

  it('reports how many more sightings the CLOSEST one needs, not the average', () => {
    // One fact two-thirds of the way there is the useful number: it says the
    // wait is one call, not three.
    const s = summariseUsability([
      mem(withCalls('c1')),
      mem(withCalls('c1', 'c2')), // needs 1
      mem(withCalls('c1'))
    ])
    expect(s.nearestNeeds).toBe(1)
    expect(s.detail).toContain('1 more')
  })

  it('counts a WORKING brain honestly too', () => {
    const s = summariseUsability([
      mem({ status: 'active' }),
      mem({ status: 'active' }),
      mem(withCalls('c1'))
    ])
    expect(s.headline).toBe('2 of 3 in use.')
    expect(s.waiting).toBe(1)
  })

  it('says so plainly when everything learned is in use', () => {
    const s = summariseUsability([mem({ status: 'active' })])
    expect(s.detail).toBe('Everything learned is in use.')
  })

  it('an empty brain is a different message from a stuck one', () => {
    // "Nothing learned yet" is a new install. "73 learned, none in use" is a
    // fault. Collapsing them is how the fault stayed invisible.
    const empty = summariseUsability([])
    expect(empty.headline).toContain('has not learned anything yet')
    expect(empty.headline).not.toContain('in use')
    expect(summariseUsability([mem(withCalls('c1'))]).headline).toContain('none in use')
  })

  it('does not count invalidated memories as waiting', () => {
    const s = summariseUsability([mem({ status: 'invalidated' }), mem(withCalls('c1'))])
    expect(s.invalidated).toBe(1)
    expect(s.waiting).toBe(1)
    expect(s.total).toBe(2)
  })
})

describe('BUG-258 — episodes are counted the way promotion counts them', () => {
  it('two pieces of evidence from ONE call are one episode', () => {
    // Mirrors consolidation.ts's distinctEpisodeCount. Counting raw evidence
    // rows would tell the user a fact is nearly trusted when it has been seen
    // exactly once.
    expect(distinctEpisodes([
      { type: 'transcript', callId: 'c1' },
      { type: 'transcript', callId: 'c1' }
    ] as Memory['evidence'])).toBe(1)
  })

  it('two different calls are two episodes', () => {
    expect(distinctEpisodes([
      { type: 'transcript', callId: 'c1' },
      { type: 'transcript', callId: 'c2' }
    ] as Memory['evidence'])).toBe(2)
  })

  it('a fact seen in one call is reported as needing two more, not three', () => {
    const s = summariseUsability([mem(withCalls('c1', 'c1'))]) // same call twice
    expect(s.nearestNeeds).toBe(2)
  })

  it('never reports needing zero more while still a hypothesis', () => {
    // A hypothesis at or past the threshold has not been promoted yet for some
    // other reason; telling the user "0 more" would promise something the next
    // call will not deliver.
    const s = summariseUsability([mem(withCalls('c1', 'c2', 'c3', 'c4'))])
    expect(s.nearestNeeds).toBe(1)
  })

  it('handles a memory with no evidence at all without throwing', () => {
    expect(summariseUsability([mem({ evidence: [] as Memory['evidence'] })]).nearestNeeds).toBe(3)
  })
})
