// BUG-258 — say what the Sales Brain can actually USE, not how much it has.
//
// The headline was `<strong>{weeklyCount}</strong> new thing(s) learned this
// week`, counting memories CREATED regardless of status. Measured on the
// founder's own profile 2026-09-10: 73 memories, **0 of them `active`**, every
// compiled profile 0 characters, and all six consumers concatenating an empty
// string for months. The number on screen said the Brain was working the entire
// time.
//
// Worse: that card only rendered `when weeklyCount > 0`, so a week with nothing
// new showed NOTHING — the one state where a user most needs to be told
// something is wrong is the state the UI was silent in.
//
// The per-row truth already existed ("Trusted fact" / "Still a hunch"). What was
// missing was the aggregate, and an aggregate that counts a different thing than
// the rows it summarises is a lie by arithmetic, not by wording. Same species as
// the outcome counter: the number a user reads should be the number that is
// doing something.
//
// Pure and separately tested because it is a CLAIM about the product's state,
// and a claim buried in JSX cannot be driven.
import type { Memory } from '../../../../preload/index.d'

/** consolidation.ts's PROMOTION_THRESHOLD_EPISODES. Duplicated across the
 *  process boundary — the renderer cannot import main — so it is named and
 *  pinned by test rather than left as a bare 3 in a sentence. */
export const PROMOTION_THRESHOLD_EPISODES = 3

export interface MemoryUsability {
  total: number
  /** The only status any feature reads. Everything else is invisible to them. */
  usable: number
  waiting: number
  invalidated: number
  /** How many more independent sightings the closest-to-promotion hypothesis
   *  needs. Null when there is nothing waiting. */
  nearestNeeds: number | null
  headline: string
  detail: string
}

/** Mirrors consolidation.ts's distinctEpisodeCount: two evidence entries from
 *  the SAME call are one episode, not two. Counting raw evidence rows would
 *  overstate how close a fact is to being trusted. */
export function distinctEpisodes(evidence: Memory['evidence']): number {
  const keys = new Set(
    (evidence ?? []).map((e) =>
      e.type === 'transcript'
        ? `call:${(e as { callId?: string }).callId}`
        : `reflection:${[...((e as { memoryIds?: string[] }).memoryIds ?? [])].sort().join(',')}`
    )
  )
  return keys.size
}

export function summariseUsability(memories: readonly Memory[]): MemoryUsability {
  const total = memories.length
  const usable = memories.filter((m) => m.status === 'active').length
  const waitingList = memories.filter((m) => m.status === 'hypothesis')
  const invalidated = memories.filter((m) => m.status === 'invalidated').length

  const nearestNeeds = waitingList.length
    ? Math.min(
        ...waitingList.map((m) => Math.max(1, PROMOTION_THRESHOLD_EPISODES - distinctEpisodes(m.evidence)))
      )
    : null

  if (total === 0) {
    return {
      total,
      usable,
      waiting: 0,
      invalidated,
      nearestNeeds: null,
      headline: 'Sales Brain has not learned anything yet.',
      detail: 'It learns from your calls. Record one and it will start.'
    }
  }

  // THE CASE THAT WAS INVISIBLE. Saying "0 in use" without saying what would
  // change it leaves the user with a broken number and no next step.
  if (usable === 0) {
    return {
      total,
      usable,
      waiting: waitingList.length,
      invalidated,
      nearestNeeds,
      headline: `${total} learned, but none in use yet.`,
      detail:
        `A fact becomes usable once it has come up in ${PROMOTION_THRESHOLD_EPISODES} separate calls — ` +
        `until then it is a hunch, and your summaries, coaching, chat and live cues do not see it. ` +
        `${waitingList.length} ${waitingList.length === 1 ? 'is' : 'are'} waiting; the closest needs ` +
        `${nearestNeeds} more.`
    }
  }

  return {
    total,
    usable,
    waiting: waitingList.length,
    invalidated,
    nearestNeeds,
    headline: `${usable} of ${total} in use.`,
    detail: waitingList.length
      ? `${waitingList.length} still ${waitingList.length === 1 ? 'a hunch' : 'hunches'} — a fact becomes usable once it has come up in ${PROMOTION_THRESHOLD_EPISODES} separate calls. The closest needs ${nearestNeeds} more.`
      : 'Everything learned is in use.'
  }
}
