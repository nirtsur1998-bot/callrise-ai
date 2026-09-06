// FROZEN PRE-4.3 REFERENCE — no longer production code.
//
// M26 Phase 4.3 moved transcript accumulation into the main process
// (main/live/transcript-accumulator.ts). Nothing in the running app calls this
// file any more: the renderer mirrors what main sends instead of building
// anything itself. (True since 2026-09-06 — speakerKey, the one helper
// production still used, now lives in speakerKey.ts; a test in
// src/__tests__/frozen-modules-have-no-production-callers.test.ts keeps this
// claim honest.)
//
// It is kept deliberately, because it is the ORACLE. The tests that prove the
// transcript survived changing processes byte-for-byte
// (transcript-source-of-truth.test.ts and transcript-accumulator.equivalence.test.ts)
// run this implementation alongside main's and compare the two. Deleting it as
// "dead code" would delete half of that comparison and leave the other half
// asserting only that main agrees with itself.
//
// Retire it in 4.7, alongside the BUG-046 hotfix, once the migration has been
// live long enough that the comparison has stopped earning its keep.
import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'

// speakerKey lives in ./speakerKey.ts (moved 2026-09-06, species 12); the oracle
// below still uses the identical function, and the tests that import it from
// here keep working through this re-export.
import { speakerKey } from './speakerKey'
export { speakerKey }

/**
 * Whether two segments belong to the same person.
 *
 * NOT sufficient on its own to decide whether two RUNS may merge into one
 * turn — see mergeSegments, which also requires the same `epoch`. Deepgram
 * restarts diarization on every reconnect, so "speaker 0" on either side of a
 * reconnect can pass this (channel, speaker) check while being two different
 * people; `epoch` is the only signal that catches that case.
 */
export function sameSpeaker(
  a: { speaker: number; channel?: number },
  b: { speaker: number; channel?: number }
): boolean {
  return speakerKey(a) === speakerKey(b)
}

/** Group a flat list of speaker-tagged words into per-speaker runs.
 *  `meta` stamps the label namespace and attribution onto every run produced,
 *  so a turn carries who-said-it from the moment it exists. */
export function groupWords(
  words: Array<{ speaker: number; text: string; channel?: number }>,
  meta?: {
    epoch?: number
    role?: (speaker: number) => SpeakerRole
    confidence?: number
    unlabelled?: boolean
  }
): CallSegment[] {
  const out: CallSegment[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && sameSpeaker(last, word) && last.epoch === meta?.epoch) {
      last.text = `${last.text} ${text}`
    } else {
      out.push({
        speaker: word.speaker,
        text,
        ...(word.channel !== undefined ? { channel: word.channel } : {}),
        ...(meta?.epoch !== undefined ? { epoch: meta.epoch } : {}),
        ...(meta?.role ? { role: meta.role(word.speaker) } : {}),
        ...(meta?.confidence !== undefined ? { confidence: meta.confidence } : {}),
        ...(meta?.unlabelled ? { unlabelled: true } : {})
      })
    }
  }
  return out
}

/** Append newly finalized runs onto the accumulated segments, merging when the
 *  same speaker continues. Returns a new array (does not mutate `prev`).
 *
 *  Merging requires the same (channel, speaker) identity AND the same EPOCH:
 *  after a reconnect Deepgram's "speaker 0" is whoever talks first on the new
 *  connection, so merging on identity alone would silently glue two different
 *  people into one turn — the same reason a gap marker is also a hard
 *  boundary, since speech either side of one can be minutes apart. */
export function mergeSegments(prev: CallSegment[], runs: CallSegment[]): CallSegment[] {
  // Copy-on-write: only the array itself is copied here (cheap — pointers,
  // not objects). A segment object is cloned only at the moment it is
  // actually mutated (the "merge into the last turn" branch below), so every
  // OTHER segment keeps its exact previous reference. That reference
  // stability is load-bearing, not cosmetic — it's what lets a memoized
  // per-turn renderer skip re-rendering the whole accumulated transcript on
  // every incoming message. Live transcripts run for the length of a call, so
  // an O(segments) full re-clone (the old `prev.map(s => ({...s}))`) on every
  // finalized result got measurably more expensive turn by turn — worse still
  // in multichannel, which runs two independent Deepgram result streams and
  // so calls this roughly twice as often per minute of call time as mono.
  const next = [...prev]
  for (const run of runs) {
    const last = next[next.length - 1]
    if (
      last &&
      last.kind !== 'gap' &&
      run.kind !== 'gap' &&
      sameSpeaker(last, run) &&
      last.epoch === run.epoch
    ) {
      next[next.length - 1] = { ...last, text: `${last.text} ${run.text}` }
    } else {
      next.push({ ...run })
    }
  }
  return next
}
