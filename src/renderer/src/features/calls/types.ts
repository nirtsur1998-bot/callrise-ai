export interface CallSegment {
  speaker: number
  text: string
}

export interface CallSummary {
  id: string
  title: string
  createdAt: string
  durationMs: number
  speakerCount: number
  preview: string
}

export interface Call extends CallSummary {
  segments: CallSegment[]
}
