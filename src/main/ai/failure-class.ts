// BUG-057 Phase 2 — one shared classifier for every provider adapter, so
// "how does this failure behave over time" is decided in one place instead
// of reimplemented (and drifting) per provider. Pure functions, no SDK
// dependency — unit-testable without standing up a real provider.
import type { AIFailureClass, AIProviderErrorCode } from './types'

const QUOTA_KEYWORDS = ['quota', 'billing', 'credit']

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
  if (opts.status !== undefined) {
    if (opts.status >= 500) return 'transient' // server-side hiccup, not our request's fault
    if (opts.status >= 400) return 'structural' // client-side: this exact request is rejected
  }
  // No status, no quota keyword — genuinely ambiguous. See doc comment above.
  return 'transient'
}
