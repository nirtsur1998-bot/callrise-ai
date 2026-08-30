import type { AssistantTraceStep } from '../../../../preload/index.d'

/**
 * The one collapsed line that stands in for the whole stream-of-thought.
 *
 * Pure, and separate from the component, for the reason BUG-140 forces:
 * component render output cannot be tested in this repo, so the rule lives
 * where a test can reach it. And there IS a rule here, not just formatting —
 * the founder's constraint was that the trace shows what actually happened,
 * "never what was planned", and that empty and failed outcomes are stated
 * rather than omitted: *"Looked for Ben's past calls · none found" is more
 * trustworthy than silence.*
 *
 * So the summary is built to make the unhappy outcomes VISIBLE WHILE
 * COLLAPSED. A line that says "3 steps" hides exactly the information someone
 * opens a reasoning trace to find — they open it because the answer surprised
 * them, and "one lookup found nothing" is usually why.
 */
export function traceSummary(steps: AssistantTraceStep[]): string {
  if (steps.length === 0) return 'How Rise answered this'

  const ok = steps.filter((s) => s.status === 'ok').length
  const none = steps.filter((s) => s.status === 'none').length
  const failed = steps.filter((s) => s.status === 'failed').length

  const parts: string[] = []
  // "used" reads as what contributed to the answer, which is what the reader
  // is actually asking about.
  if (ok > 0) parts.push(ok === 1 ? '1 source used' : `${ok} sources used`)
  // Surfaced in the COLLAPSED line on purpose — see the note above.
  if (none > 0) parts.push(none === 1 ? '1 found nothing' : `${none} found nothing`)
  if (failed > 0) parts.push(failed === 1 ? '1 failed' : `${failed} failed`)

  if (parts.length === 0) return 'How Rise answered this'
  return `How Rise answered this — ${parts.join(', ')}`
}

/** Whether the collapsed line should draw attention. A trace where everything
 *  worked is a curiosity; one where a source came back empty or broken is a
 *  reason the answer may be thin, and the reader deserves the hint without
 *  having to open it. */
export function traceHasGaps(steps: AssistantTraceStep[]): boolean {
  return steps.some((s) => s.status === 'none' || s.status === 'failed')
}
