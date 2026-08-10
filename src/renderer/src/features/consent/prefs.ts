// Consent preferences + helpers. The per-call consent record lives on disk with
// the call (main process); these are just the user's reusable defaults — the
// editable disclosure script and the default jurisdiction — kept in localStorage
// (a renderer-only preference, no new storage layer).

import type { ConsentJurisdiction, ConsentRecord } from '@renderer/features/calls/types'

export const DEFAULT_SCRIPT =
  'Hi, just so you know, I use a tool that records and transcribes our call so I can follow up properly — is that okay with you?'

const JURISDICTION_KEY = 'salesos.consent.jurisdiction'
const SCRIPT_KEY = 'salesos.consent.script'

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* best-effort: preferences are non-critical */
  }
}

/** Default jurisdiction — two-party (the safer assumption) unless overridden. */
export function loadDefaultJurisdiction(): ConsentJurisdiction {
  return readLocal(JURISDICTION_KEY) === 'one-party' ? 'one-party' : 'two-party'
}

export function saveDefaultJurisdiction(j: ConsentJurisdiction): void {
  writeLocal(JURISDICTION_KEY, j)
}

export function loadScript(): string {
  const s = readLocal(SCRIPT_KEY)
  return s && s.trim() ? s : DEFAULT_SCRIPT
}

export function saveScript(s: string): void {
  writeLocal(SCRIPT_KEY, s)
}

/**
 * The consent record a new call starts with.
 *
 * Normally that is "not asked" with other-party recording OFF — the rep has to
 * ask on this call, on the record, before the buyer is ever captured.
 *
 * With STANDING consent on (Settings → "Always record the other party"), a new
 * call instead starts already consented, with `method: 'pre-agreed'`. Note what
 * this does and does not do: it does not bypass consent, it RECORDS one. The
 * call still carries a real, timestamped ConsentRecord saying consent was
 * pre-agreed, so `sanitizeConsent`'s invariant is untouched and the saved call
 * is honest about how consent was obtained. What the rep skips is the clicking,
 * not the consent — which is only defensible when a standing basis genuinely
 * exists, and only they can know that.
 */
export function freshConsent(standing = false): ConsentRecord {
  const jurisdiction = loadDefaultJurisdiction()
  if (!standing) return { status: 'not-asked', jurisdiction, recordOtherParty: false }
  const now = new Date().toISOString()
  return {
    status: 'consented',
    jurisdiction,
    method: 'pre-agreed',
    recordOtherParty: true,
    disclosedAt: now,
    decidedAt: now
  }
}

/** Whether a record's consent came from the standing setting rather than from
 *  the rep asking on this specific call. */
export function isStandingConsent(r: ConsentRecord): boolean {
  return r.status === 'consented' && r.method === 'pre-agreed'
}

/** Renderer mirror of the main-process invariant (no consent ⇒ no capture). */
export function canRecordOtherParty(r: ConsentRecord): boolean {
  return r.status === 'consented' && r.recordOtherParty === true
}
