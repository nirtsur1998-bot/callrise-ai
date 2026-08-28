// M29 B2 — the decision and the offline-grace policy, pure and exhaustive.
import { describe, expect, it } from 'vitest'
import { decideEntitled } from '../decide'
import { isInForce, OFFLINE_GRACE_MS } from '../store'
import type { Entitlement, GatedFeature } from '../types'

const NOW = 1_000_000_000_000

function ent(over: Partial<Entitlement>): Entitlement {
  return {
    userId: 'u',
    plan: 'pro',
    status: 'active',
    currentPeriodEnd: NOW + 1000,
    seats: 1,
    org: null,
    managedAi: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    ...over
  }
}

describe('isInForce — offline grace', () => {
  it('active and before period end: in force', () => {
    expect(isInForce(ent({ currentPeriodEnd: NOW + 1000 }), NOW)).toBe(true)
  })

  it('just past period end but within grace: still in force', () => {
    expect(isInForce(ent({ currentPeriodEnd: NOW - 1000 }), NOW)).toBe(true)
  })

  it('past period end AND past grace: not in force', () => {
    expect(isInForce(ent({ currentPeriodEnd: NOW - OFFLINE_GRACE_MS - 1 }), NOW)).toBe(false)
  })

  it('exactly at the grace boundary: still in force (inclusive)', () => {
    expect(isInForce(ent({ currentPeriodEnd: NOW - OFFLINE_GRACE_MS }), NOW)).toBe(true)
  })

  it('perpetual (null period end): in force regardless of time', () => {
    expect(isInForce(ent({ currentPeriodEnd: null }), NOW + 999 * OFFLINE_GRACE_MS)).toBe(true)
  })

  it('canceled perpetual: NOT in force (explicit cancel beats perpetual)', () => {
    expect(isInForce(ent({ currentPeriodEnd: null, status: 'canceled' }), NOW)).toBe(false)
  })

  it('status none: never in force even with a future period end', () => {
    expect(isInForce(ent({ currentPeriodEnd: NOW + OFFLINE_GRACE_MS, status: 'none' }), NOW)).toBe(false)
  })
})

describe('decideEntitled', () => {
  const F = '_never' as GatedFeature
  const grants = { pro: new Set<GatedFeature>([F]) }

  it('enforcement OFF (beta): always true, even with no entitlement', () => {
    expect(decideEntitled(F, null, false, NOW, grants)).toBe(true)
    expect(decideEntitled(F, null, false, NOW)).toBe(true) // default (empty) grants too
  })

  it('enforcement ON, no entitlement: false', () => {
    expect(decideEntitled(F, null, true, NOW, grants)).toBe(false)
  })

  it('enforcement ON, in-force pro that grants the feature: true', () => {
    expect(decideEntitled(F, ent({ plan: 'pro' }), true, NOW, grants)).toBe(true)
  })

  it('enforcement ON, in-force plan that does NOT grant the feature: false', () => {
    // A 'free' plan is in force but grants nothing in this map.
    expect(decideEntitled(F, ent({ plan: 'free' }), true, NOW, grants)).toBe(false)
  })

  it('enforcement ON, entitlement expired past grace: false even though the plan would grant it', () => {
    const expired = ent({ plan: 'pro', currentPeriodEnd: NOW - OFFLINE_GRACE_MS - 1 })
    expect(decideEntitled(F, expired, true, NOW, grants)).toBe(false)
  })

  it('the default production grants map is empty — no feature is paid yet', () => {
    // Even an in-force pro grants nothing until Part D is decided and PLAN_GRANTS filled.
    expect(decideEntitled(F, ent({ plan: 'pro' }), true, NOW)).toBe(false)
  })
})
