// Renderer-side types mirroring the preload bridge (src/preload/index.d.ts),
// kept local so the feature is self-contained — same convention as
// features/coaching/types.ts and features/knowledge/types.ts.

export type MinedObjectionType = 'price' | 'timing' | 'competitor' | 'approval' | 'trust' | 'other'

/** One mined objection→response pair. A SUGGESTION for human review, not a
 *  fact — recoveredWell/judgmentNote are the model's best read of the
 *  surrounding conversation. */
export interface MinedObjectionCandidate {
  type: MinedObjectionType
  objectionQuote: string
  objectionSpeaker: number
  objectionVerified: boolean
  responseQuote: string
  responseSpeaker: number
  responseVerified: boolean
  recoveredWell: boolean
  judgmentNote: string
}

export const TYPE_LABEL: Record<MinedObjectionType, string> = {
  price: 'Price',
  timing: 'Timing',
  competitor: 'Competitor',
  approval: 'Needs approval',
  trust: 'Trust / skepticism',
  other: 'Other'
}

/** A mined candidate staged for human review — not yet a real script. */
export interface ObjectionQueueItem {
  id: string
  type: MinedObjectionType
  objectionQuote: string
  objectionSpeaker: number
  responseQuote: string
  responseSpeaker: number
  recoveredWell: boolean
  judgmentNote: string
  callId: string
  callTitle: string
  createdAt: string
}
