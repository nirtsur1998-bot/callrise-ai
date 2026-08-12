// M26 Phase 3 — the review state of one "Generate CRM note" run, kept as
// pure logic with no Electron import so it stays testable the way
// crm-note-generator.ts and coaching-chat.ts are.
//
// Why this exists at all: the generator makes TWO AI calls and hands back
// two things the rep deals with separately — a drafted note (one Save
// click) and a list of suggested contact-field updates (accepted or
// skipped one at a time). Before M26 both lived only in the card's React
// state, so navigating off the Contact page threw away every unreviewed
// one, already paid for. Now the job holds the AI output AND the rep's
// decisions about it, so a reopen (even after an app restart) picks up
// exactly where they left off. This module owns the "what's still
// outstanding" arithmetic that makes that work.
import type { KycFact } from './crm-note-generator'

/** The rep's decisions so far. Absent fields mean "nothing decided yet". */
export interface CrmNoteReview {
  /** The drafted note has been saved to the contact, or explicitly
   *  discarded — either way it no longer needs review. */
  noteHandled?: boolean
  /** Fact ids actually applied to the contact. */
  accepted?: string[]
  /** Fact ids the rep said no to. Permanent by design — a suggestion the
   *  rep already judged must not come back and re-ask, which would erode
   *  trust in the suggestions faster than anything else. They stay
   *  VISIBLE though (see skippedFacts) so a mis-click leaves a trace
   *  rather than silently destroying one specific suggestion. */
  skipped?: string[]
}

/** What a `crmNote:generate` job resolves with, and carries in resultData. */
export interface CrmNoteJobResult {
  note: string
  facts: KycFact[]
  review?: CrmNoteReview
}

export type CrmNoteDecision =
  | { kind: 'note-handled' }
  | { kind: 'fact-accepted'; factId: string }
  | { kind: 'fact-skipped'; factId: string }

function uniquePush(list: string[] | undefined, value: string): string[] {
  const current = list ?? []
  return current.includes(value) ? current : [...current, value]
}

/** Narrows an unknown resultData (it round-trips through JSON on disk and
 *  over IPC) into a usable result, or null if it isn't one. */
export function asCrmNoteJobResult(value: unknown): CrmNoteJobResult | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.note !== 'string' || !Array.isArray(v.facts)) return null
  return v as unknown as CrmNoteJobResult
}

/** Suggestions the rep hasn't decided on yet — what the card actually
 *  shows. Anything already accepted or skipped is gone from here. */
export function pendingFacts(result: CrmNoteJobResult): KycFact[] {
  const accepted = new Set(result.review?.accepted ?? [])
  const skipped = new Set(result.review?.skipped ?? [])
  return result.facts.filter((f) => !accepted.has(f.id) && !skipped.has(f.id))
}

/** Suggestions the rep said no to. Surfaced (collapsed) rather than hidden:
 *  skipping is permanent, so a mis-click would otherwise destroy one
 *  specific suggestion with no trace — worse than the data-loss bug this
 *  whole migration fixes, which at least lost everything or nothing. */
export function skippedFacts(result: CrmNoteJobResult): KycFact[] {
  const skipped = new Set(result.review?.skipped ?? [])
  return result.facts.filter((f) => skipped.has(f.id))
}

/** True once nothing is left for the rep to look at — the note is dealt
 *  with AND every suggestion has been accepted or skipped. Only then is it
 *  safe to dismiss the job; until then it still holds unreviewed,
 *  already-paid-for AI output. */
export function isFullyReviewed(result: CrmNoteJobResult): boolean {
  if (!result.review?.noteHandled) return false
  return pendingFacts(result).length === 0
}

/** Apply one decision, returning a new result (never mutates). */
export function withDecision(
  result: CrmNoteJobResult,
  decision: CrmNoteDecision
): CrmNoteJobResult {
  const review: CrmNoteReview = { ...(result.review ?? {}) }
  if (decision.kind === 'note-handled') {
    review.noteHandled = true
  } else if (decision.kind === 'fact-accepted') {
    review.accepted = uniquePush(review.accepted, decision.factId)
  } else {
    review.skipped = uniquePush(review.skipped, decision.factId)
  }
  return { ...result, review }
}
