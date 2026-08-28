// M29 B2 — the verify-never-mint property, proven against a real test keypair.
// The client holds only the public key: it can verify a Pro entitlement but
// cannot forge one. Every rejection path is exercised by breaking exactly one
// thing and watching the specific reason come back.
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseToken, signTokenForTest, verifyToken } from '../token'
import { openBetaEntitlement, type Entitlement } from '../types'

function keypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

function proFor(userId: string): Entitlement {
  return {
    userId,
    plan: 'pro',
    status: 'active',
    currentPeriodEnd: 4_000_000_000_000,
    seats: 1,
    org: null,
    managedAi: false,
    stripeCustomerId: 'cus_test',
    stripeSubscriptionId: 'sub_test'
  }
}

describe('verifyToken', () => {
  it('accepts a token signed by the matching private key for the right user', () => {
    const { publicKey, privateKey } = keypair()
    const token = signTokenForTest(proFor('user-1'), privateKey)
    const r = verifyToken(token, 'user-1', publicKey)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entitlement.plan).toBe('pro')
      expect(r.entitlement.userId).toBe('user-1')
    }
  })

  it('rejects a token whose claim was tampered after signing', () => {
    const { publicKey, privateKey } = keypair()
    const token = signTokenForTest(proFor('user-1'), privateKey)
    const parsed = parseToken(token)!
    // Flip the claim to a different plan, keep the old signature.
    const forgedClaim = Buffer.from(
      JSON.stringify({ ...proFor('user-1'), plan: 'enterprise' }),
      'utf8'
    ).toString('base64url')
    const forged = `${forgedClaim}.${parsed.sigB64}`
    const r = verifyToken(forged, 'user-1', publicKey)
    expect(r).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it("rejects another user's validly-signed token (replay)", () => {
    const { publicKey, privateKey } = keypair()
    const token = signTokenForTest(proFor('user-1'), privateKey)
    const r = verifyToken(token, 'user-2', publicKey) // different install
    expect(r).toEqual({ ok: false, reason: 'wrong-user' })
  })

  it('rejects a token signed by a DIFFERENT key (a forger with their own keypair)', () => {
    const good = keypair()
    const attacker = keypair()
    const token = signTokenForTest(proFor('user-1'), attacker.privateKey)
    const r = verifyToken(token, 'user-1', good.publicKey)
    expect(r).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects malformed input and a missing dot separator', () => {
    const { publicKey } = keypair()
    expect(verifyToken('not-a-token', 'user-1', publicKey)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyToken('', 'user-1', publicKey)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyToken('onlyclaim.', 'user-1', publicKey)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('returns no-key (never a pass) when no public key is configured — the beta default', () => {
    const { privateKey } = keypair()
    const token = signTokenForTest(proFor('user-1'), privateKey)
    const r = verifyToken(token, 'user-1', '') // production constant is empty until the key ceremony
    expect(r).toEqual({ ok: false, reason: 'no-key' })
  })

  it('round-trips a perpetual (one-time licence) entitlement — null period end survives', () => {
    const { publicKey, privateKey } = keypair()
    const perpetual: Entitlement = { ...openBetaEntitlement('user-9'), plan: 'pro', currentPeriodEnd: null }
    const token = signTokenForTest(perpetual, privateKey)
    const r = verifyToken(token, 'user-9', publicKey)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entitlement.currentPeriodEnd).toBeNull()
  })
})
