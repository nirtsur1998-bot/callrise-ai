// M26 Phase 4.3 — the wire format between main's transcript and the renderer's
// view of it.
//
// Pure and dependency-free, like transcript-accumulator.ts, so both processes
// can import it and so the diff logic is directly unit-testable.
import type { AccumulatedSegment } from './transcript-accumulator'

/**
 * One change to the transcript: "everything from index `from` onward is now
 * this".
 *
 * ONE OPERATION, NOT THREE. The obvious protocol — append/replace-last/
 * back-fill as separate messages — has more states to get wrong than the
 * accumulator has behaviours. Splice-from covers all of them: an append is
 * `from = length`, a continued turn merging into the previous one is
 * `from = length - 1`, and a late `identifyRep` back-fill is `from` = the
 * first turn it relabelled.
 *
 * The renderer applies it as `[...prev.slice(0, from), ...segments]`, which
 * preserves the OBJECT IDENTITY of every element before `from`. That is
 * load-bearing rather than a nicety: the transcript row component is memoized
 * on identity, and two separate consumers track how far they have read by
 * index. Broadcasting a whole fresh array each time would re-render every row
 * of a 45-minute call on every utterance, and would silently reset both
 * watermarks.
 */
export interface TranscriptPatch {
  /** Which call this belongs to. A patch for a call the renderer is not
   *  mirroring is either a stale straggler or evidence the renderer missed a
   *  call boundary — never something to apply blindly. */
  callId: string
  /** 0 when a call begins (the reset marker), then strictly +1 per change. A
   *  gap here means a patch was missed, which is the one failure that would
   *  otherwise diverge the two copies silently and permanently. */
  seq: number
  from: number
  segments: AccumulatedSegment[]
}

/** What the renderer learns when it asks main "is there a call in progress?".
 *
 *  `session` and `call` are reported separately because they are nulled
 *  independently: a mono<->multichannel switch replaces the session while the
 *  call continues, and the stop path leaves a session object alive for over a
 *  second after the call is logically over. */
export interface AttachSnapshot {
  /** Non-null ONLY when a session is live and not already stopping. This being
   *  null is the single affirmative answer of "there is no call in progress" —
   *  nothing else in the system is allowed to conclude that. */
  session: {
    id: number
    multichannel: boolean
    producerId: number | null
    state: 'connecting' | 'listening' | 'reconnecting' | 'error' | 'idle'
  } | null
  call: {
    callId: string
    startedAt: string
    startedAtMs: number
    /** The patch sequence this snapshot is current as of, so the renderer can
     *  discard patches it already contains and detect ones it missed. */
    seq: number
    segments: AccumulatedSegment[]
  } | null
}

/**
 * The first index at which two transcript versions differ, or -1 if they are
 * identical.
 *
 * Compares by REFERENCE, not by value, and that is exact rather than a
 * heuristic: TranscriptAccumulator is strictly copy-on-write — it rebuilds the
 * array and replaces only the objects it actually changed — so an unchanged
 * element is always the same object. Deep-comparing would be both slower and
 * no more correct.
 *
 * Deriving the patch this way, rather than having the accumulator report what
 * it touched, is deliberate: it leaves transcript-accumulator.ts completely
 * untouched, which is what keeps the 4.1 byte-identity equivalence test a
 * valid check on the thing that actually runs.
 */
export function diffFrom(prev: AccumulatedSegment[], next: AccumulatedSegment[]): number {
  const shared = Math.min(prev.length, next.length)
  for (let i = 0; i < shared; i++) {
    if (prev[i] !== next[i]) return i
  }
  // No difference within the overlap: either something was appended (the
  // common case) or — never expected from the accumulator, which only grows —
  // the transcript shrank. Both are expressed as "everything from the end of
  // the shorter one onward".
  if (prev.length !== next.length) return shared
  return -1
}

/** Apply one patch. Kept here rather than in the renderer so both sides of the
 *  protocol are defined in one file and the equivalence test can drive the
 *  real implementation instead of a copy of it. */
export function applyPatch(
  prev: AccumulatedSegment[],
  patch: Pick<TranscriptPatch, 'from' | 'segments'>
): AccumulatedSegment[] {
  return [...prev.slice(0, patch.from), ...patch.segments]
}
