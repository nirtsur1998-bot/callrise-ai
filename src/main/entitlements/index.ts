// M29 B2 — the entitlements front door. `isEntitled(feature)` is the ONLY
// entitlement check in the app: one helper, so a second subtly-different copy
// can never drift in (the `cancellable:true` lesson from M26, applied to
// money). Everything else — a menu item, a job executor, a settings card —
// asks this, never reads the token or the plan directly.
//
// See docs/M29-B2-entitlements-memo.md for the whole design and the decisions
// still owned by the founder.

import { app } from 'electron'
import { join } from 'node:path'
import { getSignedInUserId } from '../auth'
import { decideEntitled } from './decide'
import { readCachedToken, writeCachedToken } from './store'
import { verifyToken } from './token'
import { openBetaEntitlement, type Entitlement, type GatedFeature } from './types'

// IMPORTANT: this module MUST NOT import the remote-flags module. Enforcement
// is a LOCAL constant, never a remote flag — the remote-flags memo's hard rule
// is "a flag can never grant or revoke a paid feature," and a remotely-toggled
// enforcement switch would hand Pro to everyone if flipped off (a config
// compromise = free-money exploit). A structural test asserts the missing
// import. The beta -> enforced transition is a shipped build, not a switch.

/** LOCAL, compile-time. `false` = beta: every user has every feature, exactly
 *  as today. A future release flips this to `true` when billing ships. */
export const ENTITLEMENTS_ENFORCED = false

function cachePath(): string {
  return join(app.getPath('userData'), 'entitlement-token.enc')
}

/**
 * Resolve the current user's entitlement: verify the cached token against the
 * signed-in user, or fall back to the open beta entitlement. Returns null only
 * when there is no signed-in user AND enforcement is on (nothing to grant to).
 */
async function resolveEntitlement(): Promise<Entitlement | null> {
  const userId = await getSignedInUserId()
  if (!ENTITLEMENTS_ENFORCED) {
    // Beta: an open entitlement for whoever is here (a stable userId is not
    // even required — decideEntitled ignores it when enforcement is off).
    return openBetaEntitlement(userId ?? 'beta')
  }
  if (!userId) return null
  const raw = readCachedToken(cachePath())
  if (!raw) return null
  const result = verifyToken(raw, userId)
  return result.ok ? result.entitlement : null
}

/**
 * THE gate. True when the user may use `feature`. During beta
 * (`ENTITLEMENTS_ENFORCED = false`) this is always true and touches nothing
 * else. Async because resolving the signed-in user is async; callers that need
 * a synchronous answer at a hot path should cache the result at feature
 * entry, not call this per frame.
 */
export async function isEntitled(feature: GatedFeature): Promise<boolean> {
  const entitlement = await resolveEntitlement()
  return decideEntitled(feature, entitlement, ENTITLEMENTS_ENFORCED, Date.now())
}

/**
 * Store a freshly-obtained token (from the checkout/portal flow, later).
 * Verifies before caching — a token that doesn't verify for the current user
 * is never written, so the cache can only ever hold a valid claim.
 */
export async function cacheVerifiedToken(raw: string): Promise<boolean> {
  const userId = await getSignedInUserId()
  if (!userId) return false
  const result = verifyToken(raw, userId)
  if (!result.ok) return false
  return writeCachedToken(cachePath(), raw, Date.now())
}

export type { Entitlement, GatedFeature } from './types'
