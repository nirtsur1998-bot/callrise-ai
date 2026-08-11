// Renderer-side coaching types. Mirror the shapes the preload bridge returns
// (see src/preload/index.d.ts); kept local so the feature is self-contained.

export type CoachDimensionKey =
  'discovery' | 'engagement' | 'objection' | 'value' | 'nextStep' | 'control'

export interface CoachEvidence {
  quote: string
  speaker: number
  verified: boolean
}

export interface CoachDimension {
  key: CoachDimensionKey
  score: number
  comment: string
  evidence?: CoachEvidence
}

export interface CoachImprovement {
  kind: 'mechanical' | 'strategic'
  title: string
  detail: string
  evidence?: CoachEvidence
}

export interface CoachMetrics {
  repSpeaker: number | null
  singleSpeaker: boolean
  talkRatio: number | null
  repWords: number
  totalWords: number
  longestMonologueWords: number
  longestMonologueMinutes: number | null
  questionCount: number
  wordsPerMinute: number | null
  turns: number
  questionSpread?: number | null
  buyerQuestionCount?: number
  buyerLongestMonologueWords?: number
  pricingMentions?: number
  pricingMentionsLatePct?: number | null
  nextStepsLocked?: boolean
}

export interface CoachDealContext {
  type: 'transactional' | 'complex' | 'unknown'
  summary: string
  lens: string
}

// --- M23 Coach 2.0 --------------------------------------------------------
export type CallType = 'cold-call' | 'discovery' | 'demo' | 'closing' | 'other'

export const CALL_TYPES: CallType[] = ['cold-call', 'discovery', 'demo', 'closing', 'other']

export const CALL_TYPE_LABEL: Record<CallType, string> = {
  'cold-call': 'Cold call',
  discovery: 'Discovery',
  demo: 'Demo',
  closing: 'Closing',
  other: 'Other'
}

export type SalesMethodology = 'spin' | 'meddic' | 'meddpicc' | 'challenger' | 'sandler' | 'blended'

export const SALES_METHODOLOGIES: SalesMethodology[] = [
  'blended',
  'spin',
  'meddic',
  'meddpicc',
  'challenger',
  'sandler'
]

export const METHODOLOGY_LABEL: Record<SalesMethodology, string> = {
  blended: 'Blended (adapt per call)',
  spin: 'SPIN',
  meddic: 'MEDDIC',
  meddpicc: 'MEDDPICC',
  challenger: 'Challenger',
  sandler: 'Sandler'
}

export type SkillKey =
  | 'discovery'
  | 'listening'
  | 'objectionHandling'
  | 'valueArticulation'
  | 'pricing'
  | 'momentum'
  | 'rapport'
  | 'methodology'

export const SKILL_KEYS: SkillKey[] = [
  'discovery',
  'listening',
  'objectionHandling',
  'valueArticulation',
  'pricing',
  'momentum',
  'rapport',
  'methodology'
]

export const SKILL_LABEL: Record<SkillKey, string> = {
  discovery: 'Discovery & questioning',
  listening: 'Listening & talk balance',
  objectionHandling: 'Objection handling',
  valueArticulation: 'Value articulation',
  pricing: 'Pricing conversations',
  momentum: 'Momentum & closing',
  rapport: 'Rapport & tone',
  methodology: 'Methodology adherence'
}

export type SkillScoreSet = Record<SkillKey, number>

export interface MethodologyAssessment {
  methodology: SalesMethodology
  score: number
  comment: string
  evidence?: CoachEvidence
}

export interface SkillHistoryPoint {
  callId: string
  createdAt: string
  score: number
}

export interface SkillProgress {
  key: SkillKey
  history: SkillHistoryPoint[]
  current: number | null
  trend: 'up' | 'down' | 'flat' | null
  streakAboveTarget: number
}

export interface FocusSkillState {
  skill: SkillKey
  microBehavior: string
  since: string
  sourceCallId?: string
}

export interface FocusSkillAtCoaching {
  skill: SkillKey
  microBehavior: string
}

export interface CoachingReport {
  overallScore: number
  dealContext: CoachDealContext
  strength: { text: string; evidence?: CoachEvidence }
  dimensions: CoachDimension[]
  improvements: CoachImprovement[]
  nextAction: string
  metrics: CoachMetrics
  model: string
  createdAt: string
  callType?: CallType
  skills?: SkillScoreSet
  methodologyAdherence?: MethodologyAssessment
  focusSkillAtCoaching?: FocusSkillAtCoaching
}

// --- M23 Workstream B: coaching chat --------------------------------------

export type CoachChatRole = 'user' | 'assistant'
export type CoachChatMode = 'advisor' | 'practice'

export interface CoachChatMessage {
  id: string
  role: CoachChatRole
  text: string
  createdAt: string
  mode?: CoachChatMode
}

export interface CoachChatContextSuggestion {
  id: string
  type: 'kyc' | 'next-steps' | 'call-notes'
  field?: string
  text: string
  confidence: 'high' | 'medium'
}

export const CONTEXT_SUGGESTION_LABEL: Record<CoachChatContextSuggestion['type'], string> = {
  kyc: 'Update KYC',
  'next-steps': 'Update next steps',
  'call-notes': 'Save to call notes'
}

export interface CoachChatSendResult {
  ok: boolean
  reply?: string
  suggestions?: CoachChatContextSuggestion[]
  error?: string
  message?: string
}

export interface CoachChatTaskProposal {
  title: string
  type: 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
  priority: 'low' | 'medium' | 'high'
}
