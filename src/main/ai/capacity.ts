// M27 — "is there any usable AI capacity right now?"
//
// The signal behind quota-pressure-aware job deferral: when EVERY model this
// user has a key for is currently unusable (cooling down, daily-quota
// exhausted, or structurally broken), a BATCH/MAINTENANCE background job that
// starts now would walk its entire fallback chain, fail every entry, and
// spend nothing but time and retry pressure on an already-exhausted key.
// Holding it queued until something frees up is strictly better on every
// axis — no wasted requests, no retry storm competing with live coaching for
// the same spent quota, and it resumes the moment ANY provider recovers.
//
// WHY "EVERY MODEL", NOT "ANY FREE PROVIDER IS EXHAUSTED". The looser signal
// (defer whenever some free-tier provider is out) over-defers: a user with a
// working fallback — a paid key, a second free provider still under its cap —
// has real capacity, and stalling their background work while a perfectly
// usable provider sits idle is a worse failure than the contention this
// exists to prevent. Zero-usable-capacity is the precise condition under
// which starting the job cannot possibly help.
//
// DELIBERATELY NOT PURPOSE-AWARE. This asks about the user's whole configured
// model set, not one purpose's resolved chain. A purpose-specific version
// would need a purpose to ask about, and the caller (the job scheduler) is
// deciding whether to start a job whose eventual AI calls may span several
// purposes. The whole-set question is both the simpler one and the one that
// actually matches "there is nothing left to serve ANY of this work."
import { MODEL_CATALOG } from './model-catalog'
import { PROVIDER_REGISTRY } from './registry'
import { isUsableFor } from './model-cooldown'

/** Every catalog model whose provider currently has a key configured. Read
 *  fresh from process.env on every call, never cached — ai-keys.ts sets and
 *  deletes those vars mid-session, the same reason chain resolution re-reads
 *  them (see complete-with-fallback.ts's bundledSteps). */
function keyedCatalogIds(): string[] {
  const out: string[] = []
  for (const entry of MODEL_CATALOG) {
    if (entry.knownStale) continue // can never serve anything — see resolveConfiguredChain
    const keyEnvName = PROVIDER_REGISTRY[entry.providerId].keyEnvName
    if (!process.env[keyEnvName]?.trim()) continue
    out.push(entry.id)
  }
  return out
}

/**
 * True when at least one configured model could be attempted right now.
 *
 * Returns TRUE when no keys are configured at all — deliberately. That is a
 * setup state, not quota pressure: a user who has never added a key has no
 * capacity for an entirely different reason, and deferring their background
 * jobs (silently, behind a "waiting for provider capacity" label that implies
 * a temporary condition) would be both wrong and confusing. Those jobs should
 * run and fail with the real, actionable no-key error the app already
 * surfaces.
 *
 * Checked at the DURABLE tier with pacing ignored — see isUsableFor's own
 * `ignorePacing` doc comment. Background jobs are durable-tier by definition,
 * and a merely-paced model genuinely has capacity.
 */
export function hasUsableAiCapacity(now: number): boolean {
  const ids = keyedCatalogIds()
  if (ids.length === 0) return true // no keys at all — a setup state, not pressure
  return ids.some((id) => isUsableFor(id, now, 'durable', { ignorePacing: true }))
}
