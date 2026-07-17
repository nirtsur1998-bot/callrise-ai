// Renderer-side deal types. Mirror the shapes exposed by the preload bridge
// (see src/preload/index.d.ts); kept local so the feature is self-contained,
// matching the contacts/tasks convention.

export type DealStageKind = 'open' | 'won' | 'lost'

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

export type AssessDealRiskResult =
  | { ok: true; assessment: DealRiskAssessment }
  | { ok: false; error: 'no-key' | 'failed'; message?: string }

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
  /** Every past stage transition, oldest first — the deal's CURRENT stage
   *  (stageId, above) is not duplicated as the last entry; this is history
   *  only. Absent/empty on deals that haven't changed stage since this field
   *  was added. */
  stageHistory?: DealStageChange[]
}
