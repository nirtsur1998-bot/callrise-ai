// M28 Phase 2 — golden corpus + Q&A set for the retrieval-quality eval
// (retrieval-quality-eval.test.ts). Hand-authored to mirror what extraction
// actually produces (short factual statements), across all three scopes,
// with deliberate difficulty baked in:
//   - paraphrase questions (vector search's home turf),
//   - proper-noun questions (MiniLM-384's documented weakness — the baseline
//     should EXPOSE it, not hide it),
//   - a hypothesis-only fact (reachable only with includeHypotheses — the
//     Rise configuration's win over active-only),
//   - scope-isolation controls (client A's question must never surface
//     client B's memories),
//   - distractors that should stay quiet.
// Questions reference fixtures by KEY; the harness maps keys to real row ids
// at seed time. `acceptable` = surfacing it is fine (related), it just
// doesn't count toward recall.
import type { MemoryCandidate } from '../../types'

export interface CorpusEntry {
  key: string
  candidate: MemoryCandidate
}

function entry(
  key: string,
  scope: MemoryCandidate['scope'],
  category: MemoryCandidate['category'],
  statement: string,
  source: MemoryCandidate['source'] = 'user_confirmed'
): CorpusEntry {
  return {
    key,
    candidate: {
      scope,
      category,
      statement,
      evidence: [{ type: 'transcript', callId: `eval-call-${key}`, quote: statement }],
      confidence: source === 'auto' ? 0.4 : 0.9,
      importance: 5,
      source
    }
  }
}

// source 'user_confirmed' → inserts as ACTIVE; source 'auto' → HYPOTHESIS
// (memories-store.ts initialStatus). The two hypothesis entries below are
// the includeHypotheses measurement targets.
export const CORPUS: CorpusEntry[] = [
  // --- rep scope ---
  entry('r-long-discovery', 'rep', 'selling-pattern', 'Tends to run discovery calls long, often past 45 minutes'),
  entry('r-weak-close', 'rep', 'skill-weakness', 'Struggles to ask for the close at the end of demo calls'),
  entry('r-strong-pain', 'rep', 'skill-strength', 'Strong at surfacing pain points with open questions early in discovery'),
  entry('r-goal-talkratio', 'rep', 'stated-goal', 'Wants to get talk ratio below 40 percent this quarter'),
  entry('r-pref-morning', 'rep', 'preference', 'Prefers scheduling high-stakes negotiation calls in the morning'),
  entry('r-struggle-followup', 'rep', 'stated-struggle', 'Loses deal momentum after sending the first proposal'),
  entry('r-style-direct', 'rep', 'communication-style', 'Communicates in short direct sentences and dislikes small talk'),
  // --- business scope ---
  entry('b-pricing', 'business', 'pricing-model', 'Pricing is per seat at 49 dollars a month with a 20 percent annual discount'),
  entry('b-icp', 'business', 'icp', 'Ideal customers are mid-market logistics companies with 50 to 500 employees'),
  entry('b-competitor', 'business', 'competitor', 'Main competitor is FleetPilot, which wins on price but loses on support quality'),
  entry('b-objection-impl', 'business', 'objection-and-response', 'Most common objection is implementation time; the winning response cites the two-week onboarding guarantee'),
  entry('b-product', 'business', 'product-or-service', 'The product is a route optimization platform for delivery fleets'),
  entry('b-term-runsheet', 'business', 'terminology', 'Customers call route plans runsheets'),
  // --- client: Acme (contact eval-acme) ---
  entry('ca-decision-maker', 'client:eval-acme', 'client-fact', 'Decision maker is Dana Levy, VP of Operations'),
  entry('ca-budget', 'client:eval-acme', 'client-fact', 'Budget ceiling is around 40000 dollars for this year'),
  entry('ca-current-tool', 'client:eval-acme', 'client-fact', 'Currently using FleetPilot and unhappy with support response times'),
  entry('ca-expansion-hyp', 'client:eval-acme', 'client-fact', 'May be planning to open a second warehouse next quarter', 'auto'),
  // --- client: Globex (contact eval-globex) ---
  entry('cg-pilot-first', 'client:eval-globex', 'client-fact', 'Wants a pilot phase before committing to an annual contract'),
  entry('cg-soc2', 'client:eval-globex', 'client-fact', 'Procurement requires SOC 2 documentation before signing'),
  entry('cg-price-sensitive-hyp', 'client:eval-globex', 'client-fact', 'Seems price sensitive; asked twice about discounts', 'auto'),
  // --- distractors (plausible, should stay quiet on the questions below) ---
  entry('d-video-off', 'rep', 'preference', 'Prefers video off for internal team meetings'),
  entry('d-bilingual', 'business', 'terminology', 'Canadian customers require bilingual invoices'),
  entry('d-roadwarrior', 'business', 'competitor', 'Secondary competitor RoadWarrior rarely appears in deals'),
  entry('d-tuesday-hyp', 'rep', 'selling-pattern', 'May be more effective on Tuesday afternoon calls', 'auto')
]

export interface EvalQuestion {
  id: string
  question: string
  contactId: string | null
  /** Keys that SHOULD surface — recall is measured against these. */
  shouldSurface: string[]
  /** Surfacing these is fine (related), just not required. */
  acceptable?: string[]
  /** Keys that must NOT appear (scope isolation / relevance controls). */
  shouldNotSurface?: string[]
  /** Reachable only when hypotheses are searched (the Rise config). */
  needsHypotheses?: boolean
  note?: string
}

export const QUESTIONS: EvalQuestion[] = [
  { id: 'q-pricing', question: 'What do we charge? How does our pricing work?', contactId: null, shouldSurface: ['b-pricing'] },
  { id: 'q-objection', question: 'A prospect says rollout will take too long — how do I answer that?', contactId: null, shouldSurface: ['b-objection-impl'], note: 'paraphrase: "rollout too long" vs "implementation time"' },
  { id: 'q-icp', question: 'What kind of companies should I be targeting?', contactId: null, shouldSurface: ['b-icp'] },
  { id: 'q-competitor', question: 'Who do we usually compete against and how do we win?', contactId: null, shouldSurface: ['b-competitor'], acceptable: ['d-roadwarrior'] },
  { id: 'q-weakness', question: 'What am I weakest at on my sales calls?', contactId: null, shouldSurface: ['r-weak-close'], acceptable: ['r-struggle-followup', 'r-long-discovery'] },
  { id: 'q-closing', question: 'How can I get better at closing deals?', contactId: null, shouldSurface: ['r-weak-close'], acceptable: ['r-struggle-followup'] },
  { id: 'q-goal', question: 'What was the goal I set for myself this quarter?', contactId: null, shouldSurface: ['r-goal-talkratio'] },
  { id: 'q-acme-dm', question: 'Who makes the buying decisions at Acme?', contactId: 'eval-acme', shouldSurface: ['ca-decision-maker'], note: 'proper-noun stress: Acme appears in no statement' },
  { id: 'q-acme-budget', question: 'What did Dana say about their budget?', contactId: 'eval-acme', shouldSurface: ['ca-budget'], acceptable: ['ca-decision-maker'], note: 'proper-noun stress: Dana + budget' },
  { id: 'q-acme-tool', question: 'Why is Acme unhappy with the tool they use today?', contactId: 'eval-acme', shouldSurface: ['ca-current-tool'], acceptable: ['b-competitor'] },
  { id: 'q-acme-expansion', question: 'Is Acme planning to expand their operation?', contactId: 'eval-acme', shouldSurface: ['ca-expansion-hyp'], needsHypotheses: true, note: 'hypothesis-only fact — invisible to active-only retrieval' },
  { id: 'q-globex-process', question: 'What does Globex need before they can sign?', contactId: 'eval-globex', shouldSurface: ['cg-pilot-first', 'cg-soc2'] },
  { id: 'q-scope-isolation', question: 'Do they need SOC 2 paperwork before signing?', contactId: 'eval-acme', shouldSurface: [], shouldNotSurface: ['cg-soc2'], note: 'asked about ACME — Globex memories must not leak across client scopes' },
  { id: 'q-runsheets', question: 'What do customers mean when they say runsheets?', contactId: null, shouldSurface: ['b-term-runsheet'] }
]
