// BUG-058 — remember that a model just rate-limited us, and stop asking it.
//
// THE SPIRAL THIS EXISTS TO BREAK. Before this, nothing anywhere remembered a
// 429. Every call re-walked the chain from position 1, so the model that was
// rate-limited two seconds ago got hit first, again, every single time —
// coaching-cue fires roughly every 2.5s, so that is a doomed request every
// 2.5s against a provider actively telling us to back off. Worse, each failed
// call then walked the WHOLE remaining chain, so one provider's rate limit
// was converted into hitting every other provider's limit too: on a 9-entry
// quality chain with retries, a single failed summary costs ~25 requests
// across 6 providers. Two operations can exhaust a free-tier account set.
//
// A cooldown inverts that: under pressure the chain gets SHORTER, not longer,
// and a provider is given the time it explicitly asked for.
//
// Deliberately in-memory only. A rate limit is a seconds-to-minutes condition
// and process restarts are rare compared to its lifetime; persisting it would
// mean a stale file could suppress a model that recovered hours ago. This is
// the opposite of PurposeHealth (ai/purpose-health.ts), which persists
// precisely because it describes a days-long condition.
//
// Keyed by catalogId, not provider: Groq and Gemini rate-limit per MODEL, so
// a sibling model on the same key is often still usable. A genuine
// account-wide limit simply marks each model as it is tried.

/** Used when the provider rate-limits us but says nothing about when to come
 *  back. Long enough to actually clear a per-minute window, short enough that
 *  a model is never sidelined for a meaningful stretch on a guess. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** No provider's honest retry hint should sideline a model for longer than
 *  this. Caps a malformed or hostile `Retry-After: 86400` from removing a
 *  model for the rest of the session — past this the right answer is to try
 *  again and find out, not to trust a number indefinitely. */
export const MAX_COOLDOWN_MS = 10 * 60_000

const cooldowns = new Map<string, number>()

/** Mark a model as not-worth-asking until `retryAfterMs` from now (or the
 *  default when the provider gave no hint). Never shortens an existing
 *  cooldown: two concurrent jobs can both get 429s, and the later one
 *  reporting a shorter delay must not undo the longer wait. */
export function markRateLimited(catalogId: string, retryAfterMs: number | undefined, now: number): void {
  const wait = Math.min(
    Math.max(retryAfterMs ?? DEFAULT_COOLDOWN_MS, 1_000),
    MAX_COOLDOWN_MS
  )
  const until = now + wait
  const existing = cooldowns.get(catalogId)
  if (existing !== undefined && existing >= until) return
  cooldowns.set(catalogId, until)
}

/** When this model becomes worth trying again, or null if it is available
 *  now. Expired entries are dropped on read — there is no sweeper, and this
 *  map only ever holds models that have actually been rate-limited. */
export function cooldownUntil(catalogId: string, now: number): number | null {
  const until = cooldowns.get(catalogId)
  if (until === undefined) return null
  if (until <= now) {
    cooldowns.delete(catalogId)
    return null
  }
  return until
}

export function isCoolingDown(catalogId: string, now: number): boolean {
  return cooldownUntil(catalogId, now) !== null
}

/** A success proves the limit lifted early — trust the evidence over the
 *  estimate. Matters most when the default 60s guess was too pessimistic. */
export function clearCooldown(catalogId: string): void {
  cooldowns.delete(catalogId)
}

/** The soonest moment any of these models is worth trying again. Used to tell
 *  the user how long to wait instead of reporting a generic failure. */
export function soonestExpiry(catalogIds: string[], now: number): number | null {
  let soonest: number | null = null
  for (const id of catalogIds) {
    const until = cooldownUntil(id, now)
    if (until === null) continue
    if (soonest === null || until < soonest) soonest = until
  }
  return soonest
}

/** Test-only. */
export function resetCooldownsForTests(): void {
  cooldowns.clear()
}
