// Thin wrapper around window.api.dealIntelligence.analyzeTier1 (M24 §3) —
// converts the IPC result into nudgeEngine.ts's Tier1SignalCandidate shape.
// No policy lives here: confidence gating, priority, cooldown, dedupe, and
// suppression are all the Nudge Engine's job (nudgeEngine.ts), not this
// file's — this only calls the AI and normalizes its answer.

import type { Tier1SignalCandidate } from '../nudgeEngine'

export interface Tier1AnalyzeInput {
  transcriptDelta: string
  compactState: string
  dealContext?: string
  triggerReason?: string
  /** M26 4.5 (BUG-055) — see main/deal-tier1.ts's own doc comment. */
  sessionId?: number
  includesBuyerContent?: boolean
}

export type Tier1AnalyzeOutcome =
  | { ok: true; candidates: Tier1SignalCandidate[] }
  | { ok: false; pausedReason?: 'all-models-unavailable' | 'timed-out'; blockedReason?: 'consent' }

export async function analyzeTier1(input: Tier1AnalyzeInput): Promise<Tier1AnalyzeOutcome> {
  try {
    const result = await window.api.dealIntelligence.analyzeTier1(input)
    if (!result.ok) {
      return { ok: false, pausedReason: result.pausedReason, blockedReason: result.blockedReason }
    }
    return {
      ok: true,
      candidates: result.signals.map((s) => ({
        type: s.type,
        subtype: s.subtype,
        confidence: s.confidence,
        evidenceQuote: s.evidenceQuote,
        evidenceRole: s.evidenceRole,
        suggestedCue: s.suggestedCue
      }))
    }
  } catch {
    // IPC itself failing (not the AI call — that's already caught in main and
    // returned as {ok:false}) is rare but not impossible; degrade the same way.
    return { ok: false }
  }
}
