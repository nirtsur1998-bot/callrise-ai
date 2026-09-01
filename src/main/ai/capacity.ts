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
// ~~DELIBERATELY NOT PURPOSE-AWARE.~~ **WRONG, and corrected below.** The
// original version of this file argued that asking about the user's whole
// configured model set was "both the simpler question and the one that
// actually matches 'there is nothing left to serve ANY of this work'." It
// isn't. A job runs ONE purpose's chain, and that chain is a strict subset of
// the keyed catalog — narrowed by the purpose's configured assignment, and
// again by tool-capability. So every model outside it is capacity the job can
// never spend, and counting them answers a question nobody asked.
//
// Found in the field, not in review: Sales Brain's import ran straight into a
// fully-exhausted memory-extract chain while this function reported capacity,
// failed three calls in a row, and tripped the scan breaker — the app's own
// error saying "every model set up for THIS is rate-limited" while the gate
// meant to prevent exactly that said go.
//
// Worth naming precisely, because the comment that used to sit here is the
// tell: it explained why it should be trusted instead of asking what it could
// not see. That is taxonomy species 13, in our own runtime code rather than
// in a doc — see the M26 Engine Room note.
import { MODEL_CATALOG } from './model-catalog'
import { providerHasCredentials } from './provider-credentials'
import { isUsableFor } from './model-cooldown'
import { configuredStepsFor, purposeTier, resolveChain } from './complete-with-fallback'
import type { AIPurpose } from './types'

/** Every catalog model whose provider currently has a key configured. Read
 *  fresh from process.env on every call, never cached — ai-keys.ts sets and
 *  deletes those vars mid-session, the same reason chain resolution re-reads
 *  them (see complete-with-fallback.ts's bundledSteps). */
function keyedCatalogIds(): string[] {
  const out: string[] = []
  for (const entry of MODEL_CATALOG) {
    if (entry.knownStale) continue // can never serve anything — see resolveConfiguredChain
    if (!providerHasCredentials(entry.providerId)) continue
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

/**
 * The same question, asked about the chain a specific purpose will actually
 * walk — which is what a job whose AI work is all one purpose really needs.
 *
 * Uses the purpose's own resolved chain and its own tier, both from the same
 * definitions the fallback walk uses, so this can't drift into disagreeing
 * with the code it is predicting. `needsTool: true` deliberately: a tool
 * chain is the narrower of the two, and over-narrowing here is the safe
 * direction — it defers a job that might have squeaked through, where
 * over-widening starts a job that cannot possibly succeed, which is the bug
 * this exists to fix.
 *
 * Empty chain returns TRUE for the same reason the whole-set version does:
 * "nothing configured" is a setup state, and a job deferred behind a
 * "waiting for provider capacity" label would hide the real, actionable
 * no-key error instead of surfacing it.
 */
export function hasUsableCapacityForPurpose(purpose: AIPurpose, now: number): boolean {
  // BUG-159 — "is anything configured?" is asked of the CONFIGURED set, not of
  // the walk's chain.
  //
  // These were the same call, and that coupling made the signal fragile in the
  // worst direction: any change that shortened the chain (filtering out cooling
  // steps, say) emptied it exactly when everything was cooling, hit the
  // empty-means-setup-state branch, and answered "capacity exists" when there
  // was none. Deferral would stop and background jobs would hammer the
  // providers. Asking configuredStepsFor() instead makes the empty case mean
  // what it says: no keys.
  const configured = configuredStepsFor(purpose)
  if (configured.length === 0) return true
  const tier = purposeTier(purpose)
  // Usability is still judged over the steps this purpose would actually
  // attempt, which is the narrower, correct set for THAT question.
  const { capable } = resolveChain(purpose, { needsTool: true })
  const judged = capable.length > 0 ? capable : configured
  return judged.some((step) =>
    isUsableFor(step.catalogId, now, tier, { ignorePacing: true, purpose })
  )
}
