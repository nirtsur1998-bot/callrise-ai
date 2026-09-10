// M25 Sales Brain Phase 3 — the single, cheap read every other feature
// (live cues, coaching reports, pre-call brief, CRM notes) uses to pull in
// a precompiled profile. Deliberately just a DB read of an already-
// compiled row (see consolidation.ts's compileProfile) — NEVER an AI call,
// NEVER a live retrieval pass.
//
// COST, MEASURED 2026-09-08 rather than asserted: 0.059 ms per call on the
// founder's machine — 0.054 ms of it the UNCACHED readFileSync + JSON.parse
// that isSalesBrainEnabled() does via loadAppSettings(), and 0.005 ms the
// primary-key row lookup. That is 0.001% of the live-cue path's 6,000 ms
// budget, so "negligible" holds; "no latency" does not, and the settings read
// rather than the DB read is where nearly all of it goes. Injecting a second
// profile on the same path doubles it, to 0.118 ms. Returns '' (never throws, never null-checks needed by callers) when
// Sales Brain is off, not yet initialized, or no profile has been compiled
// for that scope yet (e.g. a brand-new install with zero calls processed).
import { isSalesBrainEnabled } from '../app-settings'
import { getMemoryDb } from './memory-runtime'
import { getCompiledProfile } from './memories-store'
import { clientScope, type MemoryScope, type ProfileSize } from './types'

/**
 * BUG-258 — COUNT THE EMPTY BRANCH.
 *
 * `section()` below returns '' — not even the header — when there is nothing to
 * inject. That is correct prompt hygiene, and it is exactly what hid a dead
 * feature for months: on the founder's machine all six consumers had been
 * concatenating an empty string since the Sales Brain shipped, and there was no
 * log line, no failed call, no header with nothing under it, and no counter.
 * Nothing recorded how often the empty branch was taken, so a well-behaved
 * empty case was indistinguishable from a feature that had never once worked.
 *
 * This is the cheapest fix for that: integers in memory, no I/O on the hot
 * path. It does not make the injection work — it makes the SILENCE observable,
 * which is what was missing.
 *
 * The REASON matters more than the count. "Sales Brain is off" is a user
 * choice, "no db" is a new install, and "compiled but empty" is the state that
 * means something is wrong — and all three were identical from the outside.
 */
export type InjectionOutcome = 'injected' | 'brain-off' | 'no-db' | 'compiled-but-empty'

const injectionCounts = new Map<string, number>()

function note(scope: MemoryScope, outcome: InjectionOutcome): void {
  // Client scopes collapse to one family: a per-contact key would grow without
  // bound and would put contact ids in a support bundle.
  const family = scope.startsWith('client:') ? 'client' : scope
  const key = `${family}:${outcome}`
  injectionCounts.set(key, (injectionCounts.get(key) ?? 0) + 1)
}

/** Counts since launch, keyed `<scope family>:<outcome>`. Integers only — no
 *  scope ids, no contact ids, no statements. */
export function injectionStats(): Record<string, number> {
  return Object.fromEntries([...injectionCounts.entries()].sort())
}

/** Test-only, so one test's counts cannot leak into another's assertions. */
export function resetInjectionStats(): void {
  injectionCounts.clear()
}

function profileText(scope: MemoryScope, size: ProfileSize): string {
  if (!isSalesBrainEnabled()) {
    note(scope, 'brain-off')
    return ''
  }
  const db = getMemoryDb()
  if (!db) {
    note(scope, 'no-db')
    return ''
  }
  const text = getCompiledProfile(db, scope, size)?.text ?? ''
  note(scope, text ? 'injected' : 'compiled-but-empty')
  return text
}

/** Wraps `text` in a labeled section the same shape as this codebase's
 *  existing personalizationSection()/knowledgeSection() helpers (coach.ts,
 *  live-cue.ts) — returns '' (not even the header) when there's nothing to
 *  inject, so callers can always just concatenate this into a prompt
 *  without an extra empty-check. */
function section(label: string, text: string): string {
  return text ? `\n\n--- ${label} ---\n${text}` : ''
}

/** The rep's own profile — how they sell, their patterns/strengths/
 *  struggles/goals. Used by: coaching reports (standard), coaching chat
 *  (full), live cues (micro). */
export function repProfileSection(size: ProfileSize): string {
  return section('WHAT WE KNOW ABOUT THIS REP (Sales Brain)', profileText('rep', size))
}

/** The rep's business — product, pricing, ICP, competitors, common
 *  objections + proven responses. Used by: CRM notes, coaching reports,
 *  pre-call brief. */
export function businessProfileSection(size: ProfileSize): string {
  return section('WHAT WE KNOW ABOUT THE BUSINESS (Sales Brain)', profileText('business', size))
}

/** A specific client's durable facts — used by: pre-call brief, coaching
 *  chat, CRM notes, practice-mode persona enrichment. `contactId` null
 *  (no linked contact) always returns '', same as every other client-scope
 *  consumer in this app. */
export function clientProfileSection(contactId: string | null, size: ProfileSize): string {
  if (!contactId) return ''
  return section('WHAT WE KNOW ABOUT THIS CLIENT (Sales Brain)', profileText(clientScope(contactId), size))
}

/** Raw (unlabeled, no "--- LABEL ---" prompt-style framing) profile text —
 *  for UI-facing consumers like the pre-call brief's "Your edge" card
 *  (prep-brief-ipc.ts), which renders this directly to the rep rather than
 *  splicing it into an AI prompt. The *Section() functions above are for
 *  prompt injection specifically; this is the plain-text counterpart. */
export function rawClientProfileText(contactId: string | null, size: ProfileSize): string {
  if (!contactId) return ''
  return profileText(clientScope(contactId), size)
}

export function rawBusinessProfileText(size: ProfileSize): string {
  return profileText('business', size)
}
