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
}
