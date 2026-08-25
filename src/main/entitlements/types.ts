// M29 B2 — the entitlement model. Every field the pricing memo's Part G says
// "must not be precluded" exists here TODAY and is simply constant, so adding
// teams, a one-time licence, or managed AI later changes only the WRITER (the
// Stripe webhook), never this shape. See docs/M29-B2-entitlements-memo.md.

/** Open-ended on purpose — a `free` or a future plan name must be
 *  representable without a code change here (memo Part G). */
export type EntitlementPlan = 'beta' | 'free' | 'pro' | (string & {})

export type EntitlementStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'none'

export interface Entitlement {
  /** The signed-in user this entitlement belongs to. A token whose userId is
   *  not the current user is rejected — one user's token can't be replayed on
   *  another's install. */
  userId: string
  plan: EntitlementPlan
  status: EntitlementStatus
  /** Epoch ms. `null` = perpetual — a one-time licence (pricing Option 3) has
   *  no period end and must be representable. */
  currentPeriodEnd: number | null
  /** 1 today; multi-seat / team licences not precluded (Part G). */
  seats: number
  /** null today; the org slot is reserved so team billing needs no reshape. */
  org: string | null
  /** Always false today, nothing reads it; reserved for the managed-AI-quota
   *  scenario the pricing memo prices out but does not build. */
  managedAi: boolean
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
}

/** The named things the app can gate. Kept as a closed union so a caller
 *  can't invent a feature string that silently always-passes — the same
 *  discipline as the telemetry signal catalog and the remote-flags allowlist.
 *  EMPTY of real gates today: which features are paid is the pricing memo's
 *  open Part D decision, and gating one before that decision would be a
 *  harness with nothing in it. `_never` keeps the union non-empty and is
 *  what the tests exercise. */
export type GatedFeature = '_never'

/** The beta-era open entitlement: everyone, everything, no expiry. Returned
 *  by the store when enforcement is off or nothing is cached, so the app
 *  behaves exactly as it does today. */
export function openBetaEntitlement(userId: string): Entitlement {
  return {
    userId,
    plan: 'beta',
    status: 'active',
    currentPeriodEnd: null,
    seats: 1,
    org: null,
    managedAi: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null
  }
}
