// THE RENDERER'S COPY of one condition from src/main/calls-fs.ts.
//
// It is a copy because it has to be: src/main is outside the renderer's
// tsconfig scope. This codebase already meets that boundary in three other
// places — calendarMatch.ts, DetectionOverlay.tsx, holdsUnreviewedOutput.ts —
// and each resolved it the same way, with a duplicate and a "keep in sync"
// comment. That comment is principle 8's own tell for a correspondence that
// will eventually drift, and a comment is an instruction to a future reader
// who will not read it.
//
// The duplicate cannot be removed here, so it is PINNED instead:
// src/main/__tests__/consent-ui-predicate-parity.test.ts reads both source
// files and fails if the two conditions stop matching character-for-character.
// Forgetting goes from silent to red — the same move as `cancellable`
// defaulting to false. If you change the condition, change it in BOTH files;
// the test will tell you immediately if you did not.
//
// SOURCE OF TRUTH: `coachingHistoryDropped` in src/main/calls-fs.ts.

/** The consent record the renderer needs to answer this — a structural subset
 *  of the main-side ConsentRecord, not a re-declaration of it. */
interface ConsentShape {
  recordOtherParty?: boolean
}

/**
 * Does this call's coaching thread get dropped for lack of recording consent?
 *
 * THE `consent != null` HALF IS LOAD-BEARING. applyConsentRetention
 * early-returns when there is no consent record at all, so a legacy call
 * without one is never stripped. `recordOtherParty !== true` alone is TRUE for
 * such a call, and would tell the rep their coaching history had been
 * discarded when nothing was ever touched.
 */
export function coachingHistoryDropped(call: { consent?: ConsentShape }): boolean {
  return call.consent != null && call.consent.recordOtherParty !== true
}
