import type { KnowledgeEntry, ObjectionEntry, TextEntry } from './knowledge-fs'

/**
 * Simple architecture (no embeddings/RAG yet): the WHOLE knowledge base is
 * assembled into one text block and handed to Claude as context, both for
 * live cues (M-live-coaching) and post-call summaries/coaching. That only
 * scales while the knowledge base stays small — see the size thresholds below.
 */

export type KnowledgeSizeLevel = 'ok' | 'large' | 'over'

export interface KnowledgeContextPreview {
  text: string
  charCount: number
  /** Rough estimate only (~4 characters per token for English text) — not an
   *  exact tokenizer count, just enough to judge "is this getting too big". */
  estimatedTokens: number
  level: KnowledgeSizeLevel
}

// Live cues resend the WHOLE knowledge base on every buyer turn (every ~0.5s
// during a call), so this is the tightest budget in the app. Thresholds are
// picked around that: comfortably under ~4,000 characters keeps cues fast and
// cheap; past ~10,000 characters the per-turn cost/latency starts to bite and
// it's a sign the simple "stuff everything in" approach is running out of
// runway (a future RAG/embeddings upgrade would fetch only the relevant bits
// instead of resending everything, every time).
const WARN_AT_CHARS = 4000
const OVER_AT_CHARS = 10000
const CHARS_PER_TOKEN = 4

/** Oldest-first within a category, so the assembled text reads like a
 *  document written in the order the entries were added. */
function byCreatedAtAsc(a: KnowledgeEntry, b: KnowledgeEntry): number {
  return a.createdAt.localeCompare(b.createdAt)
}

/** Build the exact text block Claude is given as context. */
function isObjection(e: KnowledgeEntry): e is ObjectionEntry {
  return e.category === 'objection'
}

function isTextEntry(category: 'product' | 'playbook') {
  return (e: KnowledgeEntry): e is TextEntry => e.category === category
}

export function assembleKnowledgeContext(entries: KnowledgeEntry[]): string {
  const objections = entries.filter(isObjection).sort(byCreatedAtAsc)
  const product = entries.filter(isTextEntry('product')).sort(byCreatedAtAsc)
  const playbook = entries.filter(isTextEntry('playbook')).sort(byCreatedAtAsc)

  const sections: string[] = []

  if (objections.length) {
    const body = objections
      .map((e) => `When the buyer says: "${e.trigger}"\nRespond: ${e.response}`)
      .join('\n\n')
    sections.push(`=== OBJECTION SCRIPTS ===\n${body}`)
  }

  if (product.length) {
    const body = product.map((e) => `## ${e.title}\n${e.body}`).join('\n\n')
    sections.push(`=== PRODUCT INFO ===\n${body}`)
  }

  if (playbook.length) {
    const body = playbook.map((e) => `## ${e.title}\n${e.body}`).join('\n\n')
    sections.push(`=== SALES PLAYBOOK ===\n${body}`)
  }

  return sections.join('\n\n')
}

export function previewKnowledgeContext(entries: KnowledgeEntry[]): KnowledgeContextPreview {
  const text = assembleKnowledgeContext(entries)
  const charCount = text.length
  const estimatedTokens = Math.ceil(charCount / CHARS_PER_TOKEN)
  const level: KnowledgeSizeLevel =
    charCount > OVER_AT_CHARS ? 'over' : charCount > WARN_AT_CHARS ? 'large' : 'ok'
  return { text, charCount, estimatedTokens, level }
}
