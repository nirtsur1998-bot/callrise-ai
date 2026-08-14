// M27 audit — Memory Quality Eval Harness fixtures.
//
// Ground-truth facts for the THREE existing Call Simulator transcripts
// (src/renderer/src/features/deal-intelligence/simulator/transcripts/*.ts,
// M24's "healthy" / "stalling" / "authorityHeavy" fixtures). Those were
// built for Tier-0 signal testing, not memory extraction, but they are
// realistic, hand-authored, dialogue-only transcripts with unambiguous
// factual content already baked in (a specific budget number, a specific
// timeline, an explicit statement of who holds purchase authority) — which
// is exactly what a memory-extraction eval needs and exactly what BUG-043's
// "reuse the Call Simulator's scripted scenarios" idea points at. Reusing
// them (rather than authoring a fourth transcript format) also means any
// future edit to those fixtures' dialogue is visible here as a potential
// eval-fixture break, not a silent drift.
//
// LiveTurn -> CallSegment: the two shapes already share `speaker`/`text`/
// `role`/`epoch` — see deal-intelligence/types.ts's LiveTurn vs calls-fs.ts's
// CallSegment. No lossy mapping needed for extraction's purposes (it only
// ever reads speaker+text via speechSegments()).
import type { LiveTurn } from '../../../../renderer/src/features/deal-intelligence/types'
import { TRANSCRIPT as HEALTHY_TURNS } from '../../../../renderer/src/features/deal-intelligence/simulator/transcripts/healthy'
import { TRANSCRIPT as STALLING_TURNS } from '../../../../renderer/src/features/deal-intelligence/simulator/transcripts/stalling'
import { TRANSCRIPT as AUTHORITY_TURNS } from '../../../../renderer/src/features/deal-intelligence/simulator/transcripts/authorityHeavy'
import type { CallSegment } from '../../../calls-fs'

export function toCallSegments(turns: LiveTurn[]): CallSegment[] {
  return turns.map((t) => ({ speaker: t.speaker, text: t.text, role: t.role, epoch: t.epoch }))
}

/** The topical buckets the founder's ask (docs handoff, item 6 of the M27
 *  Sales Brain assignment) actually wants scored: budget, timeline, pain
 *  point, decision-maker/authority, objection. IMPORTANT CAVEAT, surfaced
 *  here rather than buried in the runner: the real schema
 *  (memory/types.ts's MEMORY_CATEGORIES) has exactly ONE client-scope
 *  category, 'client-fact' — it cannot distinguish a budget fact from a
 *  timeline fact from a pain point at the data-model level. These topical
 *  tags are therefore an EVAL-ONLY classification layered on top of the raw
 *  extracted statement text (keyword match), not something the extraction
 *  pipeline itself reports or could be asked to report today. That gap is
 *  itself a finding — see the harness's own doc comment.
 */
export type EvalTopic = 'budget' | 'timeline' | 'decision-maker' | 'pain-point' | 'objection'

export interface ExpectedFact {
  topic: EvalTopic
  /** Human-readable description of the fact a correct extraction should
   *  capture — not matched literally, just for the report. */
  description: string
  /** The extracted statement counts as a HIT for this expected fact if it
   *  contains ALL of at least one of these keyword groups (case-insensitive
   *  substring match) — deliberately loose (statements are the model's own
   *  paraphrase, never a verbatim copy of the transcript) but still specific
   *  enough that a generic/unrelated statement can't accidentally match. */
  hitIfContainsAllOf: string[][]
}

export interface EvalScenario {
  id: string
  label: string
  segments: CallSegment[]
  /** A fake but non-null contactId — extraction.ts's own guard only checks
   *  truthiness (`!contactId`), it never validates the id refers to a real
   *  Contact record, so any stable string works for eval purposes. */
  contactId: string
  expected: ExpectedFact[]
  /** Facts that must NOT be extracted as durable/settled — negative
   *  controls. 'healthy' has no real objection anywhere in it, so any
   *  extracted 'objection' candidate on that transcript is a false
   *  positive by construction, not just "unmeasured." */
  expectNoTopics?: EvalTopic[]
}

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: 'healthy',
    label: 'Healthy discovery call (Casey / Meridian Flow)',
    segments: toCallSegments(HEALTHY_TURNS),
    contactId: 'eval-contact-healthy',
    expected: [
      {
        topic: 'budget',
        description: 'Budget range of roughly $40k-$50k for the year',
        hitIfContainsAllOf: [
          ['40', '50'],
          ['budget']
        ]
      },
      {
        topic: 'timeline',
        description: 'Wants to go live by end of Q3, driven by peak season',
        hitIfContainsAllOf: [['q3'], ['peak season']]
      },
      {
        topic: 'decision-maker',
        description: 'Buyer (Casey) is the sole decision-maker with budget authority — no other stakeholder needed',
        hitIfContainsAllOf: [
          ['sole', 'authority'],
          ['budget', 'authority'],
          ['only', 'decision'],
          ['no other', 'stakeholder']
        ]
      },
      {
        topic: 'pain-point',
        description: 'Scheduling today is a spreadsheet + group texts, held together loosely',
        hitIfContainsAllOf: [
          ['spreadsheet', 'text'],
          ['spreadsheet']
        ]
      },
      {
        topic: 'pain-point',
        description: 'Single point of failure: lead dispatcher Marcus holds process knowledge in his head',
        hitIfContainsAllOf: [['marcus']]
      },
      {
        topic: 'pain-point',
        description: 'Manual payroll copy takes the ops coordinator half a day every pay period',
        hitIfContainsAllOf: [
          ['payroll', 'half a day'],
          ['payroll', 'manual']
        ]
      }
    ],
    expectNoTopics: ['objection']
  },
  {
    id: 'stalling',
    label: 'Stalling / dying deal',
    segments: toCallSegments(STALLING_TURNS),
    contactId: 'eval-contact-stalling',
    expected: [
      {
        topic: 'objection',
        description: 'Explicit budget objection: "not in the budget right now"',
        hitIfContainsAllOf: [['not', 'budget']]
      },
      {
        topic: 'timeline',
        description: 'Budget would not open up until next quarter at the earliest',
        hitIfContainsAllOf: [['next quarter']]
      },
      {
        topic: 'pain-point',
        description: 'Current process is manual notes after each call, which is not great',
        hitIfContainsAllOf: [['manual notes']]
      },
      {
        topic: 'decision-maker',
        description: 'Buyer needs to "regroup internally" before committing — implies buyer is not the sole/final decision-maker',
        hitIfContainsAllOf: [
          ['regroup', 'internal'],
          ['not', 'sole', 'decision']
        ]
      }
    ],
    // The stalling call's "budget" line is a CURRENT objection, not a settled
    // number — there is no clean numeric budget anywhere in this transcript
    // the way there is in healthy/authorityHeavy. A 'budget' topic hit here
    // that states a specific number/range would be a fabrication.
    expectNoTopics: []
  },
  {
    id: 'authorityHeavy',
    label: 'Authority/procurement-heavy call',
    segments: toCallSegments(AUTHORITY_TURNS),
    contactId: 'eval-contact-authority',
    expected: [
      {
        topic: 'budget',
        description: 'Roughly $18,000 budgeted for the year across a couple of initiatives',
        hitIfContainsAllOf: [['18', '000']]
      },
      {
        topic: 'timeline',
        description: 'Internal goal of end of Q2, before busy season — not a hard deadline',
        hitIfContainsAllOf: [['q2']]
      },
      {
        topic: 'decision-maker',
        description: 'IT director owns the final call on anything touching their systems',
        hitIfContainsAllOf: [
          ['it director'],
          ['director', 'final']
        ]
      },
      {
        topic: 'decision-maker',
        description: 'Finance must separately approve spend over a few thousand dollars a year',
        hitIfContainsAllOf: [['finance', 'approv']]
      },
      {
        topic: 'objection',
        description: 'Authority/procurement objection — buyer cannot commit to a date until IT director has reviewed it',
        hitIfContainsAllOf: [
          ['cannot', 'promise', 'date'],
          ["can't", 'promise', 'date'],
          ['until', 'it director']
        ]
      }
    ],
    // This buyer explicitly says approving vendors "is not my decision at
    // all" — a candidate that asserts THIS buyer personally holds purchase
    // authority (the opposite of what was said) would be a direct
    // contradiction of the transcript, not just a miss.
    expectNoTopics: []
  }
]
