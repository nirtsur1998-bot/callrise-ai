// M34 3d — the deal facts a live call may show: ONE line, two glances.
//
//   Proposal · ⚠ high risk · last call 27 Aug: "Send the pricing comparison"
//
// Records, never analysis. Everything here is a thing the rep set or a thing
// the app stored at the time; nothing is computed live and nothing comes from
// the outcome gate (pinned by live-imports-nothing-from-outcomes.test.ts).
//
// The precedent is the calendar chip (calendar/chipContext.ts): every field
// optional, only ever set from data we actually have, an absent field renders
// nothing rather than a placeholder — so the line can never imply a link or a
// fact that does not exist. Risk is routed through the same resolveRisk the
// chip uses, so "risk" means exactly one thing across the app.
import type { Deal, DealStage } from '@renderer/features/deals/types'
import type { CallSummary } from '@renderer/features/calls/types'
import { resolveRisk } from '@renderer/features/calendar/chipContext'

export interface LiveDealFacts {
  /** The deal's stage label, e.g. "Proposal". Absent when the meeting has no
   *  deal or the stage no longer exists. */
  stage?: string
  /** Only the two risk tiers the calendar chip shows — never the staleness
   *  ones, never a level read straight off the assessment. */
  risk?: 'high' | 'medium'
  /** The most recent SAVED call for this contact — never the one in progress,
   *  which is not saved until it ends. */
  lastCall?: {
    at: string
    /** The coach report's next action, or the summary's first action item —
     *  whichever the app stored; the rep's own record, in quotes on screen. */
    nextAction?: string
  }
}

export interface LiveDealFactsSources {
  deal: Deal | undefined
  stage: DealStage | undefined
  /** Every saved call for the meeting's contact, any order. */
  contactCalls: readonly CallSummary[]
  /** Resolved separately (one calls.get on the newest call) because the
   *  summary row does not carry the coach report. */
  lastCallNextAction: string | undefined
}

/** Newest saved call for the contact, by createdAt — or undefined. */
export function newestCall(calls: readonly CallSummary[]): CallSummary | undefined {
  let best: CallSummary | undefined
  for (const c of calls) {
    if (!best || c.createdAt.localeCompare(best.createdAt) > 0) best = c
  }
  return best
}

/** The first non-empty next action the app stored for a call. */
export function storedNextAction(call: {
  coaching?: { nextAction?: string }
  summary?: { actionItems?: string[] }
}): string | undefined {
  const fromCoach = call.coaching?.nextAction?.trim()
  if (fromCoach) return fromCoach
  const fromSummary = call.summary?.actionItems?.find((a) => a.trim().length > 0)?.trim()
  return fromSummary || undefined
}

export function buildLiveDealFacts(s: LiveDealFactsSources): LiveDealFacts | null {
  const facts: LiveDealFacts = {}
  if (s.deal && s.stage?.label) facts.stage = s.stage.label
  if (s.deal) {
    const risk = resolveRisk(s.deal, s.stage)
    if (risk) facts.risk = risk
  }
  const last = newestCall(s.contactCalls)
  if (last) {
    facts.lastCall = { at: last.createdAt }
    const next = s.lastCallNextAction?.trim()
    if (next) facts.lastCall.nextAction = next
  }
  // Nothing to say → nothing rendered. Not an empty line, not a placeholder.
  return facts.stage || facts.risk || facts.lastCall ? facts : null
}

const MAX_NEXT_ACTION = 90

/** The on-screen text, for the line and for tests: a fixed string that does
 *  not change during the call. */
export function formatLiveDealFacts(
  facts: LiveDealFacts,
  now: Date = new Date()
): { parts: string[]; lastCallLabel?: string } {
  const parts: string[] = []
  if (facts.stage) parts.push(facts.stage)
  if (facts.risk) parts.push(facts.risk === 'high' ? 'high risk' : 'medium risk')
  let lastCallLabel: string | undefined
  if (facts.lastCall) {
    const d = new Date(facts.lastCall.at)
    const sameYear = d.getFullYear() === now.getFullYear()
    const when = Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          ...(sameYear ? {} : { year: 'numeric' })
        })
    const action = facts.lastCall.nextAction
    const clipped =
      action && action.length > MAX_NEXT_ACTION ? action.slice(0, MAX_NEXT_ACTION - 1) + '…' : action
    lastCallLabel = clipped ? `last call ${when}: “${clipped}”` : `last call ${when}`
    parts.push(lastCallLabel)
  }
  return { parts, lastCallLabel }
}
