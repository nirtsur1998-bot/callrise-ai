// M36 Stage 3 item 5, step 5 — the validity window in words, for the model's
// context. Pure: no imports beyond types, so context.test.ts can pin the
// exact text. The renderer has its own, locale-aware phrasing in
// MemoryCenterSection.tsx; this one is for a prompt, where a fixed ISO day
// is the clearer token.
//
// Approximate dates never pass as real ones: an 'approx' source reads
// "around", so the model says "around March" rather than "on 14 March".
import type { Memory } from './types'

const day = (iso: string): string => iso.slice(0, 10)
const about = (iso: string, source: Memory['validFromSource']): string =>
  source === 'approx' ? `around ${day(iso)}` : day(iso)

/**
 * "" when the row carries no dates (a pre-backfill row); otherwise one
 * parenthetical: "(true since 2026-03-14)", "(true since around 2026-03-14)",
 * "(true from 2026-03-14 until 2026-07-02, then superseded)".
 */
export function describeValidity(memory: Pick<Memory, 'validFrom' | 'validFromSource' | 'validUntil' | 'validUntilSource'>): string {
  if (!memory.validFrom && !memory.validUntil) return ''
  const from = memory.validFrom ? about(memory.validFrom, memory.validFromSource) : null
  if (memory.validUntil) {
    const until = about(memory.validUntil, memory.validUntilSource)
    return from ? ` (true from ${from} until ${until}, then superseded)` : ` (true until ${until}, then superseded)`
  }
  return ` (true since ${from})`
}

/** The one-clause rule that accompanies any context holding a closed window. */
export const TEMPORAL_RULE =
  'TEMPORAL RULE: a memory marked "then superseded" was true for the period shown and is not true now. ' +
  'Use it only for a question about that period, say which period the answer covers, and if the current ' +
  'fact differs, say so in one clause. A date marked "around" is approximate — say "around", never a precise day.'
