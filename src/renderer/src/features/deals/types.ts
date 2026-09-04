// Renderer-side deal types. Mirror the shapes exposed by the preload bridge
// (see src/preload/index.d.ts); kept local so the feature is self-contained,
// matching the contacts/tasks convention.

/**
 * A SECOND, INDEPENDENT DECLARATION of main's `DealStageKind`
 * (main/deal-stages.ts) — the renderer cannot import from main.
 *
 * That independence is exactly principle 8's shape, and it bit on 2026-08-31:
 * adding 'went-quiet' to main's union left this one untouched and **the whole
 * typecheck stayed green**, because nothing forces the two to meet. The
 * renderer simply kept describing a world with three kinds while main had four.
 *
 * `deal-stage-kind-lockstep.test.ts` now reads both files and fails if they
 * disagree, the same way provider-lockstep pins the preload bridge's inline
 * unions. Keep them identical.
 */
export type DealStageKind = 'open' | 'won' | 'lost' | 'went-quiet'

export interface DealStage {
  id: string
  label: string
  kind: DealStageKind
}

export type SetDealStagesResult =
  { ok: true; stages: DealStage[] } | { ok: false; error: 'empty' | 'stage-in-use' }

export type DealRiskLevel = 'low' | 'medium' | 'high'

export interface DealRiskReason {
  text: string
  callId?: string
  callTitle?: string
}

export interface DealRiskAssessment {
  level: DealRiskLevel
  summary: string
  reasons: DealRiskReason[]
  suggestedAction: string
  model: string
  createdAt: string
}

export interface DealStageChange {
  stageId: string
  changedAt: string
}

export interface Deal {
  id: string
  title: string
  contactId: string
  stageId: string
  value?: number
  expectedCloseDate?: string
  notes?: string
  createdAt: string
  updatedAt: string
  riskAssessment?: DealRiskAssessment
  /** Every PAST risk assessment, oldest first — the current one (above) is
   *  not duplicated as the last entry. Same "history alongside a current
   *  value" shape as stageHistory below. Absent/empty until a deal's risk
   *  has been re-assessed at least once. */
  riskAssessmentHistory?: DealRiskAssessment[]
  /** Every past stage transition, oldest first — the deal's CURRENT stage
   *  (stageId, above) is not duplicated as the last entry; this is history
   *  only. Absent/empty on deals that haven't changed stage since this field
   *  was added. */
  stageHistory?: DealStageChange[]
  /** M32 Stage 2 — why the deal ended this way, in the user's own words.
   *  Optional in the strongest sense: the prompt that fills it is skippable in
   *  one action, never blocks, and stops asking after repeated skips. Captured
   *  on WON deals too, so the record isn't one-armed. */
  outcomeReason?: string
}

/**
 * M32 Stage 2 — a SECOND independent declaration of main's `BackfillAnswer`
 * (main/deal-outcomes.ts), for the same reason DealStageKind above is one:
 * the renderer cannot import from main. Pinned by
 * `deal-union-lockstep.test.ts`, which reads all three files as text.
 */
export type BackfillAnswer = 'won' | 'lost' | 'went-quiet' | 'dont-remember' | 'not-a-deal'

export interface OutcomeCounts {
  won: number
  lost: number
  wentQuiet: number
  dontRemember: number
  notADeal: number
  unanswered: number
}

/**
 * Whether anything may be said about outcomes yet.
 *
 * The `insufficient` arm carries counts and NOTHING ELSE — no effect size, no
 * direction, no percentage. There is therefore nothing for this renderer to
 * accidentally display as a finding, and no number for a caveat to be read as.
 * That is a structural guarantee, not a convention: adding an analysis number
 * to this arm fails `deal-outcomes.test.ts`.
 */
export type Insight =
  | {
      status: 'insufficient'
      counts: OutcomeCounts
      usable: { won: number; lost: number; wentQuiet: number }
      /** Deals in each arm regardless of whether any call is linked. Lets the
       *  counter tell "no deals" apart from "no measurable calls on them" —
       *  two situations needing opposite actions, which the first version of
       *  the counter reported identically. */
      closed: { won: number; lost: number; wentQuiet: number }
      needPerArm: number
      bindingArm: 'won' | 'lost'
      backfillUntrustworthy: boolean
    }
  | {
      status: 'ready'
      counts: OutcomeCounts
      usable: { won: number; lost: number; wentQuiet: number }
      closed: { won: number; lost: number; wentQuiet: number }
    }

export interface BackfillRow {
  contactId: string
  name: string
  company?: string
  callCount: number
  lastCallAt?: string
  lastCallTitle?: string
  answer?: BackfillAnswer
  dealId?: string
  /** How many calls the answer ACTUALLY linked — not the row's call total.
   *  The two differ when a call was already linked elsewhere or a write
   *  failed, and the row's confirmation line must report the real number. */
  linkedCallCount?: number
  /** BUG-184 — this answer was rebuilt from the deal it created because the
   *  answers file had no record of it (the file is not backed up; deals are). */
  reconstructed?: boolean
}

export interface BackfillState {
  rows: BackfillRow[]
  answered: number
  total: number
  /** Contacts with at least one coached call, BEFORE the has-a-deal exclusion
   *  — so an empty list can say which of its two causes applies (species 62:
   *  "everyone's covered" and "nothing is linked yet" need opposite actions). */
  coachedContactTotal: number
  insight: Insight
}
