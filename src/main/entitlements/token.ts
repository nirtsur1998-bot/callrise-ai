// M29 B2 — verify, never mint. An entitlement travels as a signed token: a
// JSON claim + an Ed25519 signature. The client ships only the PUBLIC key, so
// it can verify a Pro entitlement but can never forge one; the private key
// lives in the Stripe webhook's server environment and signs the claim after
// payment clears. This is docs/M29-audit.md §5's "signed entitlement token"
// made concrete, and the property that is miserable to retrofit — so it is
// built and tested now, against a test keypair.
//
// NO Electron import: pure node:crypto, so it runs under plain vitest.

import { verify as edVerify } from 'node:crypto'
import type { Entitlement } from './types'

/** The production public key (SPKI PEM), filled at the key ceremony (memo
 *  decision 2). Empty until then; an empty key makes every token fail
 *  verification, which is the safe direction — enforcement is off in beta
 *  anyway, so no user is affected. */
export const ENTITLEMENT_PUBLIC_KEY_PEM = ''

/** A token is `base64url(claimJson) + '.' + base64url(signature)`. The
 *  signature is over the RAW claim bytes, so re-serialisation quirks can
 *  never change what was signed. */
export interface SignedToken {
  claimB64: string
  sigB64: string
}

export type VerifyResult =
  | { ok: true; entitlement: Entitlement }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'wrong-user' | 'no-key' }

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

export function parseToken(raw: string): SignedToken | null {
  if (typeof raw !== 'string') return null
  const dot = raw.indexOf('.')
  if (dot <= 0 || dot === raw.length - 1) return null
  return { claimB64: raw.slice(0, dot), sigB64: raw.slice(dot + 1) }
}

/**
 * Verify a token's signature and that it belongs to `expectedUserId`.
 *
 * Deliberately does NOT check expiry here — expiry is a policy decision with
 * an offline-grace window that belongs to the store (store.ts), not to
 * cryptographic validity. A token can be perfectly signed and still past its
 * period; those are two different questions and conflating them is how a
 * grace window gets accidentally skipped.
 *
 * `publicKeyPem` is injectable for tests; production callers pass the constant.
 */
export function verifyToken(
  raw: string,
  expectedUserId: string,
  publicKeyPem: string = ENTITLEMENT_PUBLIC_KEY_PEM
): VerifyResult {
  if (!publicKeyPem) return { ok: false, reason: 'no-key' }

  const parsed = parseToken(raw)
  if (!parsed) return { ok: false, reason: 'malformed' }

  let claimBytes: Buffer
  let sigBytes: Buffer
  try {
    claimBytes = b64urlDecode(parsed.claimB64)
    sigBytes = b64urlDecode(parsed.sigB64)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  let signatureOk = false
  try {
    signatureOk = edVerify(null, claimBytes, publicKeyPem, sigBytes)
  } catch {
    // A malformed key or signature buffer throws rather than returning false —
    // treat as an invalid signature, never as a pass.
    return { ok: false, reason: 'bad-signature' }
  }
  if (!signatureOk) return { ok: false, reason: 'bad-signature' }

  let claim: Entitlement
  try {
    claim = JSON.parse(claimBytes.toString('utf8')) as Entitlement
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!claim || typeof claim !== 'object' || typeof claim.userId !== 'string') {
    return { ok: false, reason: 'malformed' }
  }
  // The token is bound to a user; one user's signed token must not authorise
  // another user's install (a shared/leaked token replay).
  if (claim.userId !== expectedUserId) return { ok: false, reason: 'wrong-user' }

  return { ok: true, entitlement: claim }
}

/**
 * TEST-ONLY signer. The real signer is the server-side webhook; this exists
 * so the verification path can be exercised end to end without a server. It
 * lives here, guarded, rather than in a test file so the exact
 * claim-serialisation the verifier expects is defined in one place.
 */
export function signTokenForTest(entitlement: Entitlement, privateKeyPem: string): string {
  // Lazy require so a production bundle never pulls `sign` in via this module's
  // top level; verification (the only shipped path) needs only `verify`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sign } = require('node:crypto') as typeof import('node:crypto')
  const claimBytes = Buffer.from(JSON.stringify(entitlement), 'utf8')
  const sig = sign(null, claimBytes, privateKeyPem)
  return `${claimBytes.toString('base64url')}.${sig.toString('base64url')}`
}
