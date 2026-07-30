// M20: per-job (AIPurpose) ordered model-fallback-chain settings shape.
// Pure settings sanitize/merge logic only, same sanitizeX/mergeX pair
// convention as DetectionSettings/SpeakerIdSettings in app-settings.ts -
// deliberately has NO import of app-settings.ts (avoids a cycle) and no
// import of model-catalog.ts/ai/index.ts (the actual chain-resolution
// runtime logic lives in complete-with-fallback.ts, which imports this file,
// not the other way around).
import type { AIPurpose } from './types'
import { CHAIN_BUDGET } from './types'

export interface ModelAssignment {
  /** Ordered catalog-entry IDs (see model-catalog.ts). Empty means "no
   *  explicit assignment" - completeWithFallback()'s resolution rule then
   *  falls back to today's getActiveAIProvider() behavior (if configured)
   *  or the bundled DEFAULT_CATALOG_CHAIN, never straight to "unconfigured." */
  chain: string[]
}

export type ModelAssignments = Record<AIPurpose, ModelAssignment>

const EMPTY_ASSIGNMENT: ModelAssignment = { chain: [] }

export const DEFAULT_MODEL_ASSIGNMENTS: ModelAssignments = {
  'coaching-cue': EMPTY_ASSIGNMENT,
  summary: EMPTY_ASSIGNMENT,
  scorecard: EMPTY_ASSIGNMENT,
  tasks: EMPTY_ASSIGNMENT,
  other: EMPTY_ASSIGNMENT,
  'prep-brief': EMPTY_ASSIGNMENT
}

/** Deduplicated, and capped to CHAIN_BUDGET[purpose].maxChainLength when one
 *  exists (today: only 'coaching-cue', capped at 2 - see types.ts's
 *  CHAIN_BUDGET doc comment for why: a naive multi-model chain on the live
 *  path can reintroduce the dead-air regression M9 already fixed once). */
function sanitizeChain(value: unknown, purpose: AIPurpose): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  const deduped = [...new Set(ids)]
  const cap = CHAIN_BUDGET[purpose]?.maxChainLength
  return typeof cap === 'number' ? deduped.slice(0, cap) : deduped
}

function sanitizeAssignment(value: unknown, purpose: AIPurpose): ModelAssignment {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { chain: sanitizeChain(v.chain, purpose) }
}

export function sanitizeModelAssignments(value: unknown): ModelAssignments {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<AIPurpose, unknown>>
  return {
    'coaching-cue': sanitizeAssignment(v['coaching-cue'], 'coaching-cue'),
    summary: sanitizeAssignment(v.summary, 'summary'),
    scorecard: sanitizeAssignment(v.scorecard, 'scorecard'),
    tasks: sanitizeAssignment(v.tasks, 'tasks'),
    other: sanitizeAssignment(v.other, 'other'),
    'prep-brief': sanitizeAssignment(v['prep-brief'], 'prep-brief')
  }
}

/** Whole-chain replace per purpose (not key-by-key like capturePolicy's
 *  appOverrides) - a chain is authored as one unit in the Settings UI
 *  (picking a new primary model recomputes the whole ordered list
 *  client-side before sending the patch), so there's no concurrent-partial-
 *  edit hazard a key-by-key merge would need to guard against. */
export function mergeModelAssignments(current: ModelAssignments, patch: unknown): ModelAssignments {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Partial<Record<AIPurpose, unknown>>
  const next = { ...current }
  for (const purpose of Object.keys(current) as AIPurpose[]) {
    if (purpose in p) next[purpose] = sanitizeAssignment(p[purpose], purpose)
  }
  return next
}
