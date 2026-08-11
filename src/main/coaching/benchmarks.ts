// M23 Workstream A1 — the benchmark engine. Every number in this file is a
// tunable research-backed target, not a hardcoded opinion buried in logic —
// see the comment above each constant for where it comes from and why. Tune
// these here as more of the founder's own call data comes in; nothing else
// in the app hardcodes these numbers.
//
// IMPORTANT LIMITATION: saved CallSegment[] carries no per-segment
// timestamp (confirmed in Phase 0 — transcription.ts only stores speaker/
// text/role/channel/epoch, never a wall-clock offset). So "early vs. late in
// the call" below is a TRANSCRIPT-POSITION proxy (this segment's ordinal
// index ÷ total segments), not a literal minute mark. That's a fine proxy
// for "front-loaded vs. spread out", which is what these benchmarks actually
// care about — but it means a claim like "pricing came up at minute 42" is
// not something this module can make. A true pause-length signal ("did the
// rep wait ~3s after the buyer answered") needs real timestamps, which only
// exist LIVE (useLiveCues.ts's turn buffer) — that lives as a live-only
// meter, not here, and is not part of the post-call skill score.

import type { CallSegment, CallType, Commitment } from '../calls-fs'
import { isRepSegment, sameTurn } from '../coach-attribution'

// --- Call-type detection -----------------------------------------------

const CALL_TYPE_PATTERNS: Array<{ type: CallType; re: RegExp }> = [
  { type: 'demo', re: /\b(demo|demonstration|walkthrough|product tour)\b/i },
  { type: 'cold-call', re: /\b(cold call|intro call|introductory|prospecting|first contact)\b/i },
  {
    type: 'closing',
    re: /\b(closing|contract|proposal review|negotiat\w*|renewal|signature|sign[- ]?off)\b/i
  },
  { type: 'discovery', re: /\b(discovery|qualif\w*|needs assessment|kickoff|kick-off)\b/i }
]

/** Best-effort classification from the call's own title (which is often
 *  itself an AI-generated summary of the call, or the linked calendar
 *  event's title). Defaults to 'discovery' — the most common call type and
 *  the one the core "43/57" benchmark research targets — but this is ALWAYS
 *  overridable per call (calls:setCallType) and never re-guessed once a
 *  value is set (see setCallTypeIfUnset in calls-fs.ts). */
export function detectCallType(title: string | undefined | null): CallType {
  const t = title ?? ''
  for (const { type, re } of CALL_TYPE_PATTERNS) {
    if (re.test(t)) return type
  }
  return 'discovery'
}

// --- Talk-ratio targets, by call type -----------------------------------
// Source: conversation-intelligence research (Gong/Chorus-style benchmark
// studies) most commonly cited for the ~43/57 rep/buyer split on discovery
// calls, with rep-talk share above ~65% strongly correlated with lost deals.
// Cold calls and demos are legitimately more rep-led — the target shifts
// accordingly rather than penalizing a demo for the rep doing most of the
// talking while walking through the product.

export interface TalkRatioTarget {
  /** Ideal rep share of talk time, 0–100. */
  repTargetPct: number
  /** Rep share above this is the "strongly correlated with lost deals" zone. */
  warnAbovePct: number
}

export const TALK_RATIO_TARGETS: Record<CallType, TalkRatioTarget> = {
  'cold-call': { repTargetPct: 50, warnAbovePct: 70 },
  discovery: { repTargetPct: 43, warnAbovePct: 65 },
  demo: { repTargetPct: 55, warnAbovePct: 75 },
  closing: { repTargetPct: 45, warnAbovePct: 65 },
  other: { repTargetPct: 45, warnAbovePct: 65 }
}

// --- Discovery-question targets ------------------------------------------
// 11–14 targeted questions per call, evenly spread rather than front-loaded
// checklist-style, is the headline discovery benchmark from the brief.
export const DISCOVERY_QUESTION_TARGET = { min: 11, max: 14 } as const

// --- Monologue discipline -------------------------------------------------
// Matches the live monologue meter's own tuning (monologue.ts's
// MONOLOGUE_TUNING.nudgeMs = 75_000) rather than inventing a second number —
// the brief's "~90 seconds" is the outer edge of that same research range;
// 75s is reused here for consistency between the live meter and the
// post-call read of the same call.
export const MONOLOGUE_WARN_SECONDS = 75
export const MONOLOGUE_FLAG_SECONDS = 90

// --- Pricing conversation timing ------------------------------------------
// "3–4 buyer pricing mentions is the healthy zone" and, for calls 40+
// minutes long, pricing skewing toward the back half beats scattered early
// mentions (early price talk before value is established tends to anchor
// the buyer on cost before they've heard why it's worth it).
export const PRICING_MENTION_HEALTHY = { min: 3, max: 4 } as const
export const LONG_CALL_MINUTES_FOR_PRICING_TIMING = 40
const PRICING_KEYWORDS =
  /\b(price|pricing|cost|costs|costing|budget|quote|quoted|discount|invoice|payment plan|contract value|how much|price point|per (seat|user|month|year))\b/i

// --- Silence-after-answer note --------------------------------------------
// See the module-level comment: this benchmark needs real elapsed time
// between the buyer's turn ending and the rep's next turn starting, which
// saved transcripts don't carry. It's implemented as a LIVE-only passive
// signal (src/renderer/src/features/live/pause-discipline.ts), not here.

// --- Deterministic per-call computations ----------------------------------

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

interface Turn {
  seg: CallSegment
  speaker: number
  text: string
}

function mergeTurns(segments: CallSegment[]): Turn[] {
  const turns: Turn[] = []
  for (const s of segments) {
    const last = turns[turns.length - 1]
    if (last && sameTurn(last.seg, s)) {
      last.text += ` ${s.text}`
    } else {
      turns.push({ seg: s, speaker: s.speaker, text: s.text })
    }
  }
  return turns
}

export interface QuestionSpread {
  count: number
  /** 0–1: how evenly the rep's questions land across the call's three
   *  thirds (by transcript position). 1 = perfectly even thirds, 0 = every
   *  question landed in a single third (front-loaded checklist style). */
  evenness: number | null
}

/** Buckets the rep's turns into three equal-size (by turn count) thirds and
 *  scores evenness as 1 minus the normalized spread across bucket shares —
 *  the same idea as a coefficient-of-variation, kept simple since there are
 *  only three buckets. Null when there are too few questions to say
 *  anything meaningful (a single question can't be "spread"). */
export function computeQuestionSpread(
  segments: CallSegment[],
  repSpeaker: number | null
): QuestionSpread {
  const turns = mergeTurns(segments)
  // isRepSegment checks a turn's own recorded `role` FIRST, before ever
  // consulting `repSpeaker` — so it classifies correctly from per-segment
  // role tags even when repSpeaker itself is null (e.g. ambiguous across a
  // live reconnect). Always delegate to it rather than special-casing null,
  // which previously treated every turn (including the buyer's) as the
  // rep's the moment repSpeaker was unknown.
  const repTurns = turns.filter((t) => isRepSegment(t.seg, repSpeaker))
  if (repTurns.length === 0) return { count: 0, evenness: null }

  const thirdSize = Math.max(1, Math.ceil(repTurns.length / 3))
  const buckets = [0, 0, 0]
  let count = 0
  repTurns.forEach((t, i) => {
    const q = (t.text.match(/\?/g) ?? []).length
    if (q === 0) return
    count += q
    const bucket = Math.min(2, Math.floor(i / thirdSize))
    buckets[bucket] += q
  })

  if (count < 3) return { count, evenness: null } // too few to say anything about spread

  const share = buckets.map((b) => b / count)
  const idealShare = 1 / 3
  const deviation = share.reduce((sum, s) => sum + Math.abs(s - idealShare), 0) / 2 // 0..(2*2/3)/2 = 0..2/3
  const evenness = Math.max(0, 1 - deviation / (2 / 3))
  return { count, evenness: Math.round(evenness * 100) / 100 }
}

export interface BuyerEngagement {
  questionCount: number
  longestMonologueWords: number
}

/** The buyer-side mirror of coach.ts's computeMetrics — how much the buyer
 *  asked and how long they were able to talk uninterrupted. Longer buyer
 *  monologues and more buyer questions both read as a more engaged buyer. */
export function computeBuyerEngagement(
  segments: CallSegment[],
  repSpeaker: number | null
): BuyerEngagement {
  const turns = mergeTurns(segments)
  const buyerTurns = turns.filter((t) => !isRepSegment(t.seg, repSpeaker))
  const questionCount = buyerTurns.reduce(
    (sum, t) => sum + (t.text.match(/\?/g) ?? []).length,
    0
  )
  const longestMonologueWords = buyerTurns.reduce(
    (mx, t) => Math.max(mx, countWords(t.text)),
    0
  )
  return { questionCount, longestMonologueWords }
}

export interface PricingSignal {
  buyerMentions: number
  /** Share (0–1) of those mentions in the back half of the transcript by
   *  ordinal position. Null when there were no mentions to place. */
  latePct: number | null
}

/** Counts buyer-side pricing-keyword hits and where (by transcript
 *  position) they landed. Deliberately keyword-based rather than an AI
 *  call — matches the benchmark engine's "compute deterministically"
 *  brief, and keeps this free of extra latency/cost. */
export function computePricingSignal(
  segments: CallSegment[],
  repSpeaker: number | null
): PricingSignal {
  const total = segments.length
  if (total === 0) return { buyerMentions: 0, latePct: null }
  let buyerMentions = 0
  let lateMentions = 0
  segments.forEach((s, i) => {
    // Same isRepSegment-always fix as computeQuestionSpread — role tags
    // classify correctly even when repSpeaker is unresolved.
    if (isRepSegment(s, repSpeaker)) return
    if (!PRICING_KEYWORDS.test(s.text)) return
    buyerMentions++
    if (i / total >= 0.5) lateMentions++
  })
  return { buyerMentions, latePct: buyerMentions > 0 ? lateMentions / buyerMentions : null }
}

const DAY_NAMES = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
const NEXT_STEP_DATE_RE = new RegExp(
  `\\b(on|by)\\s+\\w+\\s+\\d{1,2}\\b` + // "by March 5"
    `|\\b(on|by)\\s+${DAY_NAMES}\\b` + // "by Friday"
    `|\\b\\d{1,2}/\\d{1,2}(/\\d{2,4})?\\b` + // "3/5" or "3/5/26"
    `|\\bnext (${DAY_NAMES}|week)\\b` + // "next Tuesday" / "next week"
    `|\\btomorrow\\b` +
    `|\\bthis (week|${DAY_NAMES})\\b`,
  'i'
)

/** Was a CONCRETE next step (with a date) actually locked in, vs. a vague
 *  "I'll follow up"? Prefers a real Commitment with a dueDate (the app's
 *  own commitment-extraction feature, §4.7) when available, and falls back
 *  to a light date-phrase scan of the AI's own nextAction text. */
export function nextStepsLocked(nextAction: string, commitments?: Commitment[]): boolean {
  if (commitments?.some((c) => c.dueDate)) return true
  return NEXT_STEP_DATE_RE.test(nextAction ?? '')
}

export interface BenchmarkSnapshot {
  callType: CallType
  questionSpread: QuestionSpread
  buyerEngagement: BuyerEngagement
  pricing: PricingSignal
  nextStepsLocked: boolean
  durationMinutes: number
}

export function computeBenchmarkSnapshot(
  segments: CallSegment[],
  durationMs: number,
  repSpeaker: number | null,
  callType: CallType,
  nextAction: string,
  commitments?: Commitment[]
): BenchmarkSnapshot {
  return {
    callType,
    questionSpread: computeQuestionSpread(segments, repSpeaker),
    buyerEngagement: computeBuyerEngagement(segments, repSpeaker),
    pricing: computePricingSignal(segments, repSpeaker),
    nextStepsLocked: nextStepsLocked(nextAction, commitments),
    durationMinutes: durationMs > 0 ? durationMs / 60_000 : 0
  }
}
