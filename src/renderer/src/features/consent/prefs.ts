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

/** A fresh consent record for a new call — other-party recording always OFF. */
export function freshConsent(): ConsentRecord {
  return { status: 'not-asked', jurisdiction: loadDefaultJurisdiction(), recordOtherParty: false }
}

/** Renderer mirror of the main-process invariant (no consent ⇒ no capture). */
export function canRecordOtherParty(r: ConsentRecord): boolean {
  return r.status === 'consented' && r.recordOtherParty === true
}
