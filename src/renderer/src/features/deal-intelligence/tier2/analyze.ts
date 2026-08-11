// Thin wrapper around window.api.dealIntelligence.analyzeTier2 (M24 §4) —
// converts the IPC result into healthScore.ts's sanitizer input. Mirrors
// tier1/analyze.ts's shape: no policy here, just calling the AI and handing
// back its raw (already main-process-sanitized) answer.

import type { HealthFactors } from '../healthScore'

export interface Tier2AnalyzeInput {
  transcriptDelta: string
  compactState: string
  dealContext?: string
  triggerReason?: string
}

export type Tier2AnalyzeOutcome =
  | { ok: true; score: number; factors: HealthFactors; topRecommendation: string }
  | { ok: false; pausedReason?: 'all-models-unavailable' }

export async function analyzeTier2(input: Tier2AnalyzeInput): Promise<Tier2AnalyzeOutcome> {
  try {
    const result = await window.api.dealIntelligence.analyzeTier2(input)
    if (!result.ok) return { ok: false, pausedReason: result.pausedReason }
    return {
      ok: true,
      score: result.result.score,
      factors: result.result.factors,
      topRecommendation: result.result.topRecommendation
    }
  } catch {
    return { ok: false }
  }
}
