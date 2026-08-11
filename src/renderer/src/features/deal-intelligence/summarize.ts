// Compact Live Call State -> plain text (M24 §3/§4 — "compact Live Call
// State, never the full transcript"). One function, deliberately terse
// output: shared by BOTH Tier 1 (every ~20s or on a Tier 0 event) and Tier 2
// (every ~2.5min or on a stage change) — a second, divergent summarizer for
// Tier 2 would just be two slightly different opinions about the same
// underlying state, which is exactly the "fourth divergent formula" risk the
// Phase 1 codebase map flagged for this feature. Its size directly
// multiplies the milestone's own token-discipline goal on every call site
// that uses it. A human-readable summary also happens to make the freshest
// LLM debugging aid possible — this is exactly what a bad Tier 1/2 prompt
// looked like.

import type { LiveCallState } from './types'

function formatMs(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatMentions(label: string, mentions: LiveCallState['budgetMentions']): string | null {
  if (mentions.length === 0) return null
  const terms = mentions.map((m) => `"${m.term}"`).join(', ')
  return `${label}: ${terms}`
}

export function summarizeLiveCallState(state: LiveCallState): string {
  const lines: string[] = []
  const elapsedMs = state.lastUpdatedAtMs - state.callStartedAtMs

  lines.push(`Elapsed: ${formatMs(elapsedMs)}. Stage: ${state.callStage}.`)

  if (state.talkRatio !== null) {
    lines.push(`Talk ratio: rep ${Math.round(state.talkRatio * 100)}%.`)
  }
  if (state.currentRepMonologueMs > 20_000) {
    lines.push(
      `Rep is currently mid-monologue, ${formatMs(state.currentRepMonologueMs)} and counting.`
    )
  }
  lines.push(`Buyer has asked ${state.buyerQuestionCount} question(s) so far.`)

  if (state.objections.length > 0) {
    const summary = state.objections
      .map(
        (o) =>
          `${o.type} (${o.status}, last mentioned ${formatMs(state.lastUpdatedAtMs - o.lastMentionedAtMs)} ago)`
      )
      .join('; ')
    lines.push(`Objections raised: ${summary}.`)
  } else {
    lines.push('No objections raised yet.')
  }

  const budget = formatMentions('Budget mentions', state.budgetMentions)
  if (budget) lines.push(budget)
  const timeline = formatMentions('Timeline mentions', state.timelineMentions)
  if (timeline) lines.push(timeline)

  if (state.agendaTopics.length > 0) {
    const covered = state.agendaTopics.filter((t) => state.topicsCovered.includes(t))
    const notCovered = state.agendaTopics.filter((t) => !state.topicsCovered.includes(t))
    lines.push(
      `Agenda topics covered: ${covered.length > 0 ? covered.join(', ') : 'none yet'}.` +
        (notCovered.length > 0 ? ` Not yet covered: ${notCovered.join(', ')}.` : '')
    )
  }

  if (state.sentimentTrajectory.length > 0) {
    const recent = state.sentimentTrajectory.slice(-5)
    const avg = recent.reduce((sum, s) => sum + s.score, 0) / recent.length
    const trend =
      avg > 0.15 ? 'trending positive' : avg < -0.15 ? 'trending negative' : 'neutral/mixed'
    lines.push(`Buyer sentiment (recent, coarse estimate): ${trend}.`)
  }

  return lines.join('\n')
}
