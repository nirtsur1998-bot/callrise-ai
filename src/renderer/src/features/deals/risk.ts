import type { BadgeTone } from '@renderer/components/Badge'

/** Shared risk-tier presentation — used by the follow-up digest and, now,
 *  the pipeline board/list so a deal's AI risk level reads identically
 *  everywhere it's surfaced. */
export const RISK_TIER_LABEL: Record<'risk-high' | 'risk-medium' | 'risk-stale', string> = {
  'risk-high': 'High risk',
  'risk-medium': 'Medium risk',
  'risk-stale': 'Risk check due'
}
export const RISK_TIER_TONE: Record<'risk-high' | 'risk-medium' | 'risk-stale', BadgeTone> = {
  'risk-high': 'danger',
  'risk-medium': 'warning',
  'risk-stale': 'neutral'
}
