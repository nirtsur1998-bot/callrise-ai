// M29 A1.3 — telemetry consent, stored in its OWN device-local file.
//
// WHY NOT app-settings.ts. The whole AppSettings object is the cloud-backup
// payload (`backup.ts` upserts `payload: settings` into `backup_settings`,
// and `applyPulledSettings` restores it on another device). A consent flag in
// there would (a) be stored under the user's ACCOUNT in Supabase — a link
// between the account and telemetry that the brief forbids — and (b) flip
// consent on a second machine that was never asked. So consent lives here,
// in `userData/telemetry-consent.json`, never backed up, never synced,
// asked on each device.
//
// 'unasked' behaves exactly like 'off'. Only 'on' enables anything.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { deleteAnonId, getOrCreateAnonId } from './anon-id'
import { NATIVE_CRASH_MARKER } from './native-crashes'
import { TelemetryQueue } from './queue'
import { clearSent } from './sent-log'

export type TelemetryConsent = 'on' | 'off' | 'unasked'

export const CONSENT_FILENAME = 'telemetry-consent.json'

export interface ConsentRecord {
  consent: TelemetryConsent
  /** When the user last decided (ISO). Absent while 'unasked'. */
  decidedAt?: string
  /** The app version that asked, so a future copy change can re-ask honestly. */
  askedWithVersion?: string
}

export function consentPath(userDataDir: string): string {
  return join(userDataDir, CONSENT_FILENAME)
}

function isConsent(v: unknown): v is TelemetryConsent {
  return v === 'on' || v === 'off' || v === 'unasked'
}

/** Read the record; anything unreadable or malformed is 'unasked' (i.e. off). */
export function readConsent(userDataDir: string): ConsentRecord {
  try {
    const path = consentPath(userDataDir)
    if (!existsSync(path)) return { consent: 'unasked' }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const rec = parsed as Partial<ConsentRecord>
    if (!isConsent(rec.consent)) return { consent: 'unasked' }
    return {
      consent: rec.consent,
      decidedAt: typeof rec.decidedAt === 'string' ? rec.decidedAt : undefined,
      askedWithVersion: typeof rec.askedWithVersion === 'string' ? rec.askedWithVersion : undefined
    }
  } catch {
    return { consent: 'unasked' }
  }
}

export interface SetConsentDeps {
  now?: () => Date
  appVersion?: string
}

/**
 * Erase every trace of telemetry from this device. The complete list, in one
 * place, so "off means off" is checkable by reading one function rather than
 * by auditing four call sites.
 *
 * Each step is independently try-wrapped: revocation must not be abandoned
 * half-done because one file was locked. That is the whole point — a partial
 * erase that stops at the first error is exactly how the sent log survived
 * opt-out before the M29 sweep found it.
 */
function eraseAllTelemetryState(userDataDir: string): void {
  try {
    deleteAnonId(userDataDir)
  } catch {
    /* keep going — every other trace must still be removed */
  }
  try {
    new TelemetryQueue(userDataDir).clear()
  } catch {
    /* same */
  }
  try {
    // The sent log holds the exact POSTed bodies, each carrying anon_id — so
    // leaving it behind left the very id the opt-out had just "deleted" in
    // plaintext on disk, and a later opt-in put BOTH ids in one file. The
    // Settings screen rendered them under a toggle reading "Off. Nothing is
    // collected or sent."
    clearSent(userDataDir)
  } catch {
    /* same */
  }
  try {
    // The native-crash marker survived opt-out too, so dumps accumulated
    // while consent was OFF were counted and reported on re-consent — a
    // measurement of the window the user said no to. Removing it makes
    // re-consent re-baseline exactly like first consent, which is what
    // native-crashes.ts already documents as the intent.
    const marker = join(userDataDir, NATIVE_CRASH_MARKER)
    if (existsSync(marker)) unlinkSync(marker)
  } catch {
    /* same */
  }
}

/**
 * Record the user's decision and apply its side effects.
 *
 *   on  → mint the anonymous id (only now — never before the user said yes)
 *   off → erase the id, the queue, the sent log and the crash marker
 *
 * THE DIRECTION RULE (founder, 2026-08-24, after the M29 sweep):
 * **opt-in may fail safe by staying off; opt-out must NEVER fail toward on.**
 *
 * That asymmetry is why the two directions are sequenced differently. The
 * previous version returned from the catch BEFORE the side-effect block, so a
 * failed opt-out write left consent 'on' on disk, the id undeleted, the queue
 * uncleared and sending live — while the toggle silently snapped back to on
 * with no error shown. The docblock even claimed a write failure "leaves the
 * previous state, which is always the safer one": true for opt-in, false for
 * the direction that matters.
 *
 * Now the erase runs FIRST and UNCONDITIONALLY for any non-'on' decision, so
 * revocation happens whether or not the record can be written. Worst case the
 * file still says 'on' and the next launch re-asks — annoying, and strictly
 * safer than sending after being told to stop.
 *
 * Returns the record AS PERSISTED, so a caller can tell a failed write from a
 * successful one. Never throws.
 */
export function setConsent(
  userDataDir: string,
  consent: TelemetryConsent,
  deps: SetConsentDeps = {}
): ConsentRecord {
  const record: ConsentRecord = {
    consent,
    decidedAt: (deps.now ?? (() => new Date()))().toISOString(),
    askedWithVersion: deps.appVersion
  }
  // Revocation first, and unconditionally: it must not depend on the write.
  if (consent !== 'on') eraseAllTelemetryState(userDataDir)
  try {
    const path = consentPath(userDataDir)
    mkdirSync(dirname(path), { recursive: true })
    // Atomic: temp + rename, so a crash mid-write can't leave a torn file
    // that reads back as something other than what the user chose.
    const tmp = `${path}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    return readConsent(userDataDir)
  }
  if (consent === 'on') {
    // Inside its own try so a failed id mint cannot throw out of setConsent —
    // the contract above says "never throws", and this line used to be the one
    // way it could. A consent file saying 'on' with no id is inert (flush
    // stops at 'no id'), and the caller sees the persisted record either way.
    try {
      getOrCreateAnonId(userDataDir)
    } catch {
      /* inert-but-on; the next toggle or launch retries the mint */
    }
  }
  return record
}

/** Test helper / "forget my decision": back to 'unasked' with every trace gone. */
export function resetConsent(userDataDir: string): void {
  try {
    const path = consentPath(userDataDir)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* best-effort */
  }
  eraseAllTelemetryState(userDataDir)
}
