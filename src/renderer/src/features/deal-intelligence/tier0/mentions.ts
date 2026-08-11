// Trigger phrases, budget/timeline mentions, and agenda-topic coverage
// (M24 §2) — every "does this text contain X" deterministic check
// lives here since they're all the same shape: substring/regex match against
// one turn, no history needed beyond what's already in state.
//
// Every match fires a signal on every occurrence — no edge-triggering, no
// dedup. That's deliberate: a phrase being said IS the discrete event, and
// deciding whether the third "not in the budget" this call is worth another
// nudge is the Nudge Engine's job (Phase 2's cooldown/dedupe/suppression),
// not Tier 0's. Compare detectMonologue/detectTalkRatio, which DO
// edge-trigger — those track a continuously-true condition, where firing on
// every turn while it holds would be noise even before the Nudge Engine gets
// a turn.
//
// Objection inference here is deliberately coarse: Tier 0 can tell a price
// objection was RAISED (a phrase matched) but never that it was ADDRESSED —
// that needs to judge whether the rep's response actually landed, which is
// semantic work for Tier 1/2 (Phase 2/3). See types.ts's Objection comment.

import type { LiveCallState, LiveTurn, MentionEvidence, ObjectionType, Tier0Signal } from '../types'

interface TriggerPhrase {
  phrase: string
  subtype: string
  objectionType?: ObjectionType
}

// Said by the buyer, matched case-insensitively as a substring. Restricted
// to the buyer's own turns (role === 'other') — the same words from the rep
// ("I know budget can be tight for teams like yours") are not the buyer
// raising anything.
const BUILT_IN_TRIGGER_PHRASES: TriggerPhrase[] = [
  { phrase: 'send me some info', subtype: 'stalling' },
  { phrase: 'send over some information', subtype: 'stalling' },
  { phrase: 'send me something', subtype: 'stalling' },
  { phrase: "we'll think about it", subtype: 'stalling' },
  { phrase: 'let me think about it', subtype: 'stalling' },
  { phrase: 'think it over', subtype: 'stalling' },
  { phrase: 'not in the budget', subtype: 'price', objectionType: 'price' },
  { phrase: "don't have the budget", subtype: 'price', objectionType: 'price' },
  { phrase: 'too expensive', subtype: 'price', objectionType: 'price' },
  { phrase: "can't afford", subtype: 'price', objectionType: 'price' },
  { phrase: 'need to check with', subtype: 'authority', objectionType: 'authority' },
  { phrase: 'not my decision', subtype: 'authority', objectionType: 'authority' },
  { phrase: 'need approval from', subtype: 'authority', objectionType: 'authority' },
  { phrase: 'need to run this by', subtype: 'authority', objectionType: 'authority' }
]

const BUDGET_PATTERN = /\$\s?\d[\d,]*(\.\d+)?|\bbudget\b/i
const TIMELINE_KEYWORDS = [
  'timeline',
  'deadline',
  'by q1',
  'by q2',
  'by q3',
  'by q4',
  'next quarter',
  'this quarter',
  'by end of',
  'go-live',
  'launch date'
]

function addMention(
  list: MentionEvidence[],
  term: string,
  evidence: MentionEvidence['evidence'][number]
): MentionEvidence[] {
  const idx = list.findIndex((m) => m.term === term)
  if (idx === -1) return [...list, { term, evidence: [evidence] }]
  const copy = [...list]
  copy[idx] = { ...copy[idx], evidence: [...copy[idx].evidence, evidence] }
  return copy
}

function raiseOrBumpObjection(
  objections: LiveCallState['objections'],
  type: ObjectionType,
  evidence: MentionEvidence['evidence'][number]
): LiveCallState['objections'] {
  const idx = objections.findIndex((o) => o.type === type)
  if (idx === -1) {
    return [
      ...objections,
      { type, status: 'raised', raisedEvidence: evidence, lastMentionedAtMs: evidence.atMs }
    ]
  }
  const copy = [...objections]
  copy[idx] = { ...copy[idx], lastMentionedAtMs: evidence.atMs }
  return copy
}

export function detectMentions(
  state: LiveCallState,
  turn: LiveTurn,
  config: { extraTriggerPhrases: string[] }
): { patch: Partial<LiveCallState>; signals: Tier0Signal[] } {
  if (turn.role === 'unknown') return { patch: {}, signals: [] }

  const lower = turn.text.toLowerCase()
  const evidence = { role: turn.role, text: turn.text, atMs: turn.atMs }
  const signals: Tier0Signal[] = []

  let objections = state.objections
  let budgetMentions = state.budgetMentions
  let timelineMentions = state.timelineMentions

  if (turn.role === 'other') {
    const phrases: TriggerPhrase[] = [
      ...BUILT_IN_TRIGGER_PHRASES,
      ...config.extraTriggerPhrases.map((phrase) => ({
        phrase: phrase.toLowerCase(),
        subtype: 'custom'
      }))
    ]
    for (const { phrase, subtype, objectionType } of phrases) {
      if (!lower.includes(phrase.toLowerCase())) continue
      signals.push({
        type: 'trigger-phrase',
        subtype,
        atMs: turn.atMs,
        evidence: [evidence],
        detail: `Matched trigger phrase: "${phrase}"`
      })
      if (objectionType) objections = raiseOrBumpObjection(objections, objectionType, evidence)
    }
  }

  if (BUDGET_PATTERN.test(turn.text)) {
    budgetMentions = addMention(budgetMentions, 'budget', evidence)
  }

  for (const keyword of TIMELINE_KEYWORDS) {
    if (!lower.includes(keyword)) continue
    timelineMentions = addMention(timelineMentions, keyword, evidence)
  }

  const topicsCovered = state.agendaTopics.every((t) => state.topicsCovered.includes(t))
    ? state.topicsCovered
    : [
        ...state.topicsCovered,
        ...state.agendaTopics.filter(
          (t) => !state.topicsCovered.includes(t) && lower.includes(t.toLowerCase())
        )
      ]

  return {
    patch: { objections, budgetMentions, timelineMentions, topicsCovered },
    signals
  }
}
