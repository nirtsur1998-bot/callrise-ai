// M29 B2 — the pure entitlement decision. No Electron, no auth, no fs: given a
// feature, an entitlement (or none), whether enforcement is on, and the time,
// decide yes/no. This is where the beta-vs-enforced posture lives, kept pure
// so it is exhaustively testable without a running app.

import { isInForce } from './store'
import type { Entitlement, GatedFeature } from './types'

/** Which plans grant which gated features. EMPTY today on purpose: no feature
 *  is paid until the pricing memo's Part D is decided, and gating one before
 *  that would be a harness with nothing in it. Adding a paid feature later is
 *  one entry here plus one `isEntitled(...)` call at its entry point. */
export const PLAN_GRANTS: Readonly<Record<string, ReadonlySet<GatedFeature>>> = {}

/** Look up whether a plan grants a feature, via the (today empty) map. */
function planGrants(
  plan: string,
  feature: GatedFeature,
  grants: Readonly<Record<string, ReadonlySet<GatedFeature>>>
): boolean {
  return grants[plan]?.has(feature) ?? false
}

/**
 * The one decision. `grants` is injectable for tests; production callers use
 * the default `PLAN_GRANTS`.
 *
 * - Enforcement OFF (beta, today) → always true: every user has every
 *   feature, exactly as the app behaves now. Nothing else is even consulted.
 * - Enforcement ON, no in-force entitlement → false.
 * - Enforcement ON, in-force entitlement → whether that plan grants the
 *   feature.
 */
export function decideEntitled(
  feature: GatedFeature,
  entitlement: Entitlement | null,
  enforced: boolean,
  now: number,
  grants: Readonly<Record<string, ReadonlySet<GatedFeature>>> = PLAN_GRANTS
): boolean {
  if (!enforced) return true
  if (!entitlement) return false
  if (!isInForce(entitlement, now)) return false
  return planGrants(entitlement.plan, feature, grants)
}
