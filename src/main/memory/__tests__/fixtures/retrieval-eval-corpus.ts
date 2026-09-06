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
  // --- M36 Stage 3 item 2 — PROPER-NOUN statements (2026-09-06). The lexical
  // gap: MiniLM-384 embeds meaning, and a name, a product, a place or a tool
  // has little meaning to embed. Each statement below is identified by such a
  // noun; each question asks by it. Added BEFORE the lexical channel so the
  // harness can show the gap and then the closing.
  entry('pn-priya-soc2', 'client:eval-acme', 'client-fact', 'Priya Nandakumar wants the SOC 2 report by the end of Q1'),
  entry('pn-tellus-renewal', 'client:eval-acme', 'client-fact', 'Their Tellus contract renews in November and auto-extends unless cancelled'),
  entry('pn-marseille-site', 'client:eval-globex', 'client-fact', 'The Marseille site runs the night shift and needs French-language training'),
  entry('pn-okafor-champion', 'client:eval-globex', 'client-fact', 'Sam Okafor is the internal champion and reports to the COO'),
  entry('pn-zendesk', 'business', 'product-or-service', 'Support tickets live in Zendesk; escalations go to the #tier2 channel'),
  entry('pn-keplerlink', 'business', 'competitor', 'KeplerLink undercuts on price but has no offline mode'),
  entry('pn-hubspot-stage', 'business', 'terminology', 'In HubSpot the stage called Verbal means a verbal yes without a signature'),
  entry('pn-bramwell', 'rep', 'communication-style', 'Bramwell Prep is the pre-call template used before every enterprise demo'),
  entry('pn-q4-lisbon', 'rep', 'stated-goal', 'Wants to close the Lisbon office deal before the Q4 kickoff'),
  entry('pn-groq', 'business', 'product-or-service', 'Call summaries are generated through Groq to keep latency under two seconds'),
  // --- distractors (plausible, should stay quiet on the questions below) ---
  // M36 Stage 3 item 2 — PER-CLIENT distractors, and why they exist: the
  // vector channel asks sqlite-vec for k = 5 per scope and only THEN applies
  // the 1.3 cut. A client scope holding five or six memories therefore
  // returns nearly all of them for any question at all, and a proper-noun
  // miss cannot show — the first run of the pn-* block scored 10/10 in the
  // bound rows with the lexical channel stashed away. A scope has to hold
  // clearly more than k plausible facts before "found by name" means anything;
  // eight distractors per client put each scope at 13–14.
  entry('dca-invoicing', 'client:eval-acme', 'client-fact', 'Invoices must be sent to accounts payable, not to the sponsor'),
  entry('dca-friday', 'client:eval-acme', 'client-fact', 'The office closes at four on Fridays, so no late calls that day'),
  entry('dca-committee', 'client:eval-acme', 'client-fact', 'Uses a three-person evaluation committee for any purchase over ten thousand'),
  entry('dca-email', 'client:eval-acme', 'client-fact', 'Prefers email over phone for follow-ups'),
  entry('dca-drivers', 'client:eval-acme', 'client-fact', 'Runs about eighty drivers across two depots'),
  entry('dca-legal', 'client:eval-acme', 'client-fact', 'Legal review adds roughly two weeks to every contract'),
  entry('dca-training', 'client:eval-acme', 'client-fact', 'Wants on-site training for dispatchers as part of onboarding'),
  entry('dca-reporting', 'client:eval-acme', 'client-fact', 'Asked for a weekly on-time delivery report for the board'),
  entry('dcg-timezone', 'client:eval-globex', 'client-fact', 'Team is spread across three time zones; mornings work best'),
  entry('dcg-integration', 'client:eval-globex', 'client-fact', 'Needs an integration with their existing warehouse management system'),
  entry('dcg-champion-left', 'client:eval-globex', 'client-fact', 'The previous sponsor left the company in the spring'),
  entry('dcg-fleet', 'client:eval-globex', 'client-fact', 'Operates a mixed fleet of vans and refrigerated trucks'),
  entry('dcg-quarterly', 'client:eval-globex', 'client-fact', 'Budget decisions are made at the quarterly planning meeting'),
  entry('dcg-security', 'client:eval-globex', 'client-fact', 'Security questionnaire has to be completed before any data is shared'),
  entry('dcg-references', 'client:eval-globex', 'client-fact', 'Asked for two customer references in the same industry'),
  entry('dcg-language', 'client:eval-globex', 'client-fact', 'Contract must be available in English and in the local language'),
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
  { id: 'q-runsheets', question: 'What do customers mean when they say runsheets?', contactId: null, shouldSurface: ['b-term-runsheet'] },
  // --- M36 Stage 3 item 2 — proper-noun questions: ask BY the noun ---
  { id: 'q-pn-priya', question: 'When does Priya want the SOC 2 report?', contactId: 'eval-acme', shouldSurface: ['pn-priya-soc2'], note: 'person name' },
  { id: 'q-pn-tellus', question: 'What happens with the Tellus contract?', contactId: 'eval-acme', shouldSurface: ['pn-tellus-renewal'], note: 'product name' },
  { id: 'q-pn-marseille', question: 'What do we know about Marseille?', contactId: 'eval-globex', shouldSurface: ['pn-marseille-site'], note: 'place name' },
  { id: 'q-pn-okafor', question: 'Who is Sam Okafor?', contactId: 'eval-globex', shouldSurface: ['pn-okafor-champion'], note: 'person name' },
  { id: 'q-pn-zendesk', question: 'Where do we track Zendesk tickets?', contactId: null, shouldSurface: ['pn-zendesk'], note: 'tool name' },
  { id: 'q-pn-keplerlink', question: 'How do we position against KeplerLink?', contactId: null, shouldSurface: ['pn-keplerlink'], acceptable: ['b-competitor'], note: 'competitor name' },
  { id: 'q-pn-hubspot', question: 'What does Verbal mean in HubSpot?', contactId: null, shouldSurface: ['pn-hubspot-stage'], note: 'tool + jargon' },
  { id: 'q-pn-bramwell', question: 'What is Bramwell Prep?', contactId: null, shouldSurface: ['pn-bramwell'], note: 'coined name' },
  { id: 'q-pn-lisbon', question: 'What was the plan for Lisbon?', contactId: null, shouldSurface: ['pn-q4-lisbon'], note: 'place name' },
  { id: 'q-pn-groq', question: 'Why do we use Groq?', contactId: null, shouldSurface: ['pn-groq'], note: 'vendor name' },
  // controls for the lexical channel. The first is a SCOPE control: a Globex
  // noun asked in an Acme-bound chat must stay unreachable — the string
  // channel obeys scope exactly as the vector channel does. The second is a
  // RELEVANCE control: a name nobody in the store has must not pull a
  // proper-noun row in by association; measured as "answered with nothing".
  // (A first version of this control listed pn-q4-lisbon as must-not-surface
  // on an Oslo question — the VECTOR channel surfaces Lisbon for Oslo, a
  // relevance wobble, and the harness counts shouldNotSurface as a scope
  // violation. That conflation would have failed option B's invariant for the
  // wrong reason, so the control was redrawn as a scope control.)
  { id: 'q-pn-control-scope', question: 'Is Marseille relevant to this account?', contactId: 'eval-acme', shouldSurface: [], shouldNotSurface: ['pn-marseille-site'], note: 'a Globex place asked in the Acme chat: the string channel must not cross scope' },
  { id: 'q-pn-control-unknown', question: 'What did Henrik say about the Oslo rollout?', contactId: null, shouldSurface: [], note: 'unknown name + place: nothing to find by string' }
]
