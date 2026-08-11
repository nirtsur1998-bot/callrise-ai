// Pure attribution helpers for the post-call coach. Split out of coach.ts —
// which imports Electron and so can't run under a plain Node test — for the
// same reason backup-core.ts was: these decide who a turn belongs to, and that
// decision is worth proving rather than assuming.
import type { CallSegment } from './calls-fs'

/**
 * Is this turn the rep's?
 *
 * Prefers the turn's OWN recorded role over the whole-call speaker number. A
 * raw number only means something inside a single speaker-label epoch —
 * Deepgram restarts diarization on every reconnect, so across one the same
 * number is a different person. Using the number alone let a buyer's words be
 * counted as the rep's talk time and quoted back as evidence for coaching them.
 *
 * 'unknown' is NOT treated as a definitive answer here (BUG-021): it means
 * "not identified live" — usually because no AI key was configured during
 * the call — not "confirmed not the rep". Falls back to the number (the
 * caller may pass a fresh post-call guess) unless the turn is `unlabelled`,
 * whose number is fabricated and can never be resolved this way. Falls back
 * to the number outright for calls saved before roles existed.
 */
export function isRepSegment(s: CallSegment, repSpeaker: number | null): boolean {
  if (s.role === 'rep') return true
  if (s.role === 'other') return false
  if (s.unlabelled) return false
  return repSpeaker !== null && s.speaker === repSpeaker
}

/**
 * Do two consecutive segments belong to the same turn?
 *
 * Requires the same speaker-label namespace (and the same recorded role), for
 * the same reason mergeSegments refuses to merge across an epoch: merging on
 * the number alone glues two different people into one turn, which then reads
 * as a single long monologue and can make one speaker's words verify as the
 * other's.
 */
export function sameTurn(a: CallSegment, b: CallSegment): boolean {
  return a.speaker === b.speaker && a.epoch === b.epoch && a.role === b.role
}

/**
 * The rep's speaker id as recorded DURING the call, if the transcript carries
 * attribution. Returns null for pre-M21 calls, or when the recorded roles
 * disagree about which id is the rep — which legitimately happens across a
 * reconnect, where the same id means different people in different epochs.
 * Ambiguity is reported as "don't know" rather than resolved by guessing.
 */
export function repSpeakerFromSegments(segments: CallSegment[]): number | null {
  const repIds = new Set<number>()
  for (const s of segments) if (s.role === 'rep') repIds.add(s.speaker)
  return repIds.size === 1 ? [...repIds][0] : null
}
