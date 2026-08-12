// M25 Sales Brain Phase 3 — the single, cheap read every other feature
// (live cues, coaching reports, pre-call brief, CRM notes) uses to pull in
// a precompiled profile. Deliberately just a DB read of an already-
// compiled row (see consolidation.ts's compileProfile) — NEVER an AI call,
// NEVER a live retrieval pass — so injecting this anywhere adds no
// meaningful latency, including on the live-cue path where that matters
// most. Returns '' (never throws, never null-checks needed by callers) when
// Sales Brain is off, not yet initialized, or no profile has been compiled
// for that scope yet (e.g. a brand-new install with zero calls processed).
import { isSalesBrainEnabled } from '../app-settings'
import { getMemoryDb } from './memory-runtime'
import { getCompiledProfile } from './memories-store'
import { clientScope, type MemoryScope, type ProfileSize } from './types'

function profileText(scope: MemoryScope, size: ProfileSize): string {
  if (!isSalesBrainEnabled()) return ''
  const db = getMemoryDb()
  if (!db) return ''
  return getCompiledProfile(db, scope, size)?.text ?? ''
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
