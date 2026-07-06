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
}
