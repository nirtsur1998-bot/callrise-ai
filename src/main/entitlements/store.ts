// M29 B2 — the device-local entitlement cache and the offline-grace policy.
// The last successfully-verified token is kept encrypted with the same
// safeStorage primitive auth.ts uses, so a paying user keeps working on a
// plane. Grace is bounded so a canceled user can't coast forever offline.
//
// This module owns the EXPIRY/GRACE decision (a policy question with a
// window), deliberately separate from token.ts, which owns cryptographic
// validity only — conflating the two is how a grace window gets skipped.

import { safeStorage } from 'electron'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import type { Entitlement } from './types'

/** Proposed 14 days past `currentPeriodEnd` (memo decision 1). A paying user
 *  whose network or our server is down stays Pro this long; a canceled user
 *  coasts at most this long offline. */
export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000

/** What we persist: the raw signed token (re-verified on every read, never
 *  trusted just because it is on disk) plus when we last saw the server say
 *  so, for diagnostics. The token itself carries the claim. */
interface CachedToken {
  token: string
  cachedAt: number
}

/** Read the cached raw token, or null. Encrypted-at-rest; an undecryptable or
 *  missing file is simply "no cache", never an error. */
export function readCachedToken(path: string): string | null {
  try {
    const raw = readFileSync(path)
    try {
      chmodSync(path, 0o600) // harden any pre-existing loose-permission file
    } catch {
      /* best effort */
    }
    if (!safeStorage.isEncryptionAvailable()) return null
    const parsed = JSON.parse(safeStorage.decryptString(raw)) as CachedToken
    return typeof parsed?.token === 'string' ? parsed.token : null
  } catch {
    return null
  }
}

/** Persist a verified token. Never writes a token we can't encrypt — a
 *  plaintext entitlement on disk is worse than losing the cache (the app
 *  re-fetches). Owner-only, mirroring auth.ts. `now` injectable for tests. */
export function writeCachedToken(path: string, token: string, now: number): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const payload: CachedToken = { token, cachedAt: now }
    writeFileSync(path, safeStorage.encryptString(JSON.stringify(payload)), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Is this entitlement still in force at time `now`, allowing the offline-grace
 * window past its period end?
 *
 * - `currentPeriodEnd === null` → perpetual (a one-time licence): always in
 *   force as long as status isn't a terminal `canceled`/`none`.
 * - otherwise in force until `currentPeriodEnd + OFFLINE_GRACE_MS`.
 *
 * A `canceled` or `none` status is never in force regardless of dates — the
 * webhook sets those the moment Stripe says so, and a cached active token
 * should not outlive an explicit cancellation beyond its own period+grace.
 */
export function isInForce(ent: Entitlement, now: number): boolean {
  if (ent.status === 'none') return false
  if (ent.currentPeriodEnd === null) {
    // Perpetual: in force unless explicitly canceled.
    return ent.status !== 'canceled'
  }
  return now <= ent.currentPeriodEnd + OFFLINE_GRACE_MS
}
