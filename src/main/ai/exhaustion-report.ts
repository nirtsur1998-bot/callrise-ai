// M28 field-diagnosis (2026-08-25) — when every model fails, SHOW WHAT EACH
// ONE SAID.
//
// Why this exists, concretely: the founder ran the work-PC test script and
// every file-upload test failed with "Every configured model failed to
// respond just now". That machine's logs cannot leave it (privacy), so the
// ONLY evidence channel is what the error itself puts on screen — and the
// walk already KNOWS the per-model reasons: AllModelsExhaustedError carries
// `attempts` with each catalogId and the provider's own error text. Rise
// discarded all of it and showed the one-line summary.
//
// This also closes half of an audit finding: "the user sees only
// AllModelsExhaustedError, which never mentions size" — a 413/oversize
// detail from a provider now appears verbatim instead of being flattened
// into "usually temporary".
//
// Reasons are shown VERBATIM (truncated, never paraphrased): this is an
// evidence channel, and paraphrasing evidence is how a 413 becomes
// "temporary". It is the user's own screen — the same text already reaches
// ai-fallback-events.jsonl on their disk.
//
// Leaf module, no imports, same pattern and same reason as
// capability-copy.ts: assistant-ipc's tests mock complete-with-fallback
// wholesale, so if this lived there, the only way to assert the user-facing
// text would be against a mock of it.

export interface ExhaustionAttempt {
  catalogId: string
  /** `${reason}: ${detail}` as the walk recorded it — the provider's own
   *  error text rides in `detail`. */
  reason: string
}

const MAX_SHOWN = 5
const MAX_REASON_CHARS = 140

/** `legacy:openai` means "the raw active-provider step with no catalog
 *  entry" — meaningless to a user. Name it for what it is. */
function displayModel(catalogId: string): string {
  return catalogId.startsWith('legacy:')
    ? `${catalogId.slice('legacy:'.length)} (your key's default model)`
    : catalogId
}

function clip(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason
}

export function exhaustionReport(
  summary: string,
  attempts: ExhaustionAttempt[] | undefined
): string {
  if (!attempts || attempts.length === 0) return summary

  // Every model failing with the IDENTICAL reason is one fact, not N — and
  // it is the single most diagnostic shape (the request itself is bad).
  const reasons = new Set(attempts.map((a) => a.reason))
  if (reasons.size === 1 && attempts.length > 1) {
    return `${summary}\n\nAll ${attempts.length} models reported the same thing:\n• ${clip(attempts[0].reason)}`
  }

  const lines = attempts
    .slice(0, MAX_SHOWN)
    .map((a) => `• ${displayModel(a.catalogId)} — ${clip(a.reason)}`)
  if (attempts.length > MAX_SHOWN) {
    lines.push(`• …and ${attempts.length - MAX_SHOWN} more`)
  }
  return `${summary}\n\nWhat each model reported:\n${lines.join('\n')}`
}
