// BUG-057 Phase 2 — one shared classifier for every provider adapter, so
// "how does this failure behave over time" is decided in one place instead
// of reimplemented (and drifting) per provider. Pure functions, no SDK
// dependency — unit-testable without standing up a real provider.
import type { AIFailureClass, AIProviderErrorCode } from './types'

const QUOTA_KEYWORDS = ['quota', 'billing', 'credit']

/** BUG-154 follow-up (2026-09-01) — the model answered, and the answer was
 *  the wrong SHAPE.
 *
 *  Every adapter raises this as AIProviderError('failed', ...) with no HTTP
 *  status (it is thrown by OUR parser after a 200, not by the provider), and
 *  no quota keyword — so classifyFailureClass fell through to its ambiguous-
 *  input default of 'transient'. Nothing was recorded, nothing was excluded,
 *  and the same model was asked the same unanswerable question forever.
 *
 *  It is not ambiguous. A model that cannot emit our tool-call/JSON shape for
 *  a given purpose will not emit it on the next attempt either — this is the
 *  same deterministic 'will not succeed for this request shape' that
 *  isStructurallyBroken() exists to describe, and model-catalog.ts:530 already
 *  counted 28 real instances of it without anything acting on the count.
 *
 *  MEASURED, not theorised: with huggingface pinned as the default provider,
 *  coaching-cue produced this failure every ~7 seconds for a whole call and
 *  never once fell back, while the 'other' purpose — same provider, same
 *  second, but a non-zero tail — fell back successfully to cloudflare.
 *
 *  Classifying it structural is safe against the doc comment below because a
 *  structural break is PURPOSE-SCOPED and carries its own self-healing TTL: a
 *  model merely having a bad generation is excluded for one purpose for a
 *  bounded window, not permanently, and a different purpose whose shape it
 *  CAN satisfy is untouched. */
const OUTPUT_SHAPE_KEYWORDS = ['expected structured output', 'malformed structured output']

export function looksLikeOutputShapeMismatch(message: string): boolean {
  const msg = message.toLowerCase()
  return OUTPUT_SHAPE_KEYWORDS.some((k) => msg.includes(k))
}

/** Same three keywords every adapter's toProviderError() already checks
 *  somewhere — evaluated here in one place instead of duplicated per
 *  provider, and now reachable from the rate-limit branch too (previously
 *  only the generic-error branch checked it, so a 429 that was actually a
 *  quota/billing exhaustion read as an ordinary short throttle). */
export function looksLikeQuotaExhaustion(message: string): boolean {
  const msg = message.toLowerCase()
  return QUOTA_KEYWORDS.some((k) => msg.includes(k))
}

/** The ambiguous-input fallback is 'transient', not 'structural': a wrong
 *  'transient' guess self-heals within a bounded cooldown, while a wrong
 *  'structural' guess would (absent its own separate self-healing TTL)
 *  permanently exclude a model on a classification we weren't even
 *  confident about. Erring toward the cheaper mistake is the actually
 *  conservative choice, not the more severe one. */
export function classifyFailureClass(
  code: AIProviderErrorCode,
  opts: { message: string; status?: number }
): AIFailureClass {
  if (code === 'network' || code === 'timeout') return 'transient'
  if (code === 'auth') return 'structural' // never succeeds until the key changes
  if (code === 'model-not-found') return 'structural'
  if (code === 'rate-limit') {
    return looksLikeQuotaExhaustion(opts.message) ? 'period-exhausted' : 'transient'
  }
  // code === 'failed' — the generic bucket every adapter uses for
  // everything it doesn't special-case (5xx, malformed 400s, a tool-schema
  // mismatch).
  if (looksLikeQuotaExhaustion(opts.message)) return 'period-exhausted'
  // BUG-154 follow-up — checked BEFORE the status branches, because this
  // failure has no status at all: it is raised by our own output parser after
  // a successful HTTP response. See looksLikeOutputShapeMismatch above.
  if (looksLikeOutputShapeMismatch(opts.message)) return 'structural'
  if (opts.status !== undefined) {
    if (opts.status >= 500) return 'transient' // server-side hiccup, not our request's fault
    if (opts.status >= 400) return 'structural' // client-side: this exact request is rejected
  }
  // No status, no quota keyword — genuinely ambiguous. See doc comment above.
  return 'transient'
}
