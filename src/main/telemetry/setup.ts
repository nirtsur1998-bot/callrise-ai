// M29 A1.3 — wiring consent to the front door, and the per-launch events.
// No Electron import: everything the app knows (paths, version) is passed in,
// so this runs under plain vitest against a temp directory.

import { join } from 'node:path'
import { readConsent, setConsent, type ConsentRecord, type TelemetryConsent } from './consent'
import { configureTelemetry, record } from './index'
import { checkNativeCrashes, NATIVE_CRASH_MARKER } from './native-crashes'

export interface TelemetrySetup {
  userDataDir: string
  appVersion: string
  /** Electron's app.getPath('crashDumps'); minidumps are counted here, never read. */
  crashDumpsDir: string
}

let setup: TelemetrySetup | null = null

/**
 * Called once at startup, after userData is known. Makes record() live —
 * which still writes nothing unless the consent file says 'on'. The gate
 * re-reads that file on every call, so a decision takes effect instantly
 * and survives the process being killed between the decision and the next
 * launch.
 */
export function setupTelemetry(next: TelemetrySetup): void {
  setup = next
  configureTelemetry({
    userDataDir: next.userDataDir,
    isEnabled: () => readConsent(next.userDataDir).consent === 'on'
  })
}

export function getTelemetrySetup(): TelemetrySetup | null {
  return setup
}

export function currentConsent(): ConsentRecord {
  return setup ? readConsent(setup.userDataDir) : { consent: 'unasked' }
}

/**
 * The user decided. Persists, applies side effects (id minted / id + queue
 * deleted), and — on a fresh 'on' — emits the session-start event so this
 * launch counts for crash-free-session math from the moment of consent.
 */
export function applyConsentDecision(consent: TelemetryConsent): ConsentRecord {
  if (!setup) return { consent: 'unasked' }
  const before = readConsent(setup.userDataDir).consent
  const rec = setConsent(setup.userDataDir, consent, { appVersion: setup.appVersion })
  if (rec.consent === 'on' && before !== 'on') {
    record('health', 'session.start', { consentJustGiven: true })
  }
  return rec
}

/**
 * Once per launch, after setup. If consent is on: count native dumps that
 * appeared since the last launch (the Sales-Brain-dead-on-a-clean-machine
 * class of failure) and mark the session as started. If not: nothing.
 */
export function recordLaunch(): void {
  if (!setup) return
  if (readConsent(setup.userDataDir).consent !== 'on') return
  const check = checkNativeCrashes(
    setup.crashDumpsDir,
    join(setup.userDataDir, NATIVE_CRASH_MARKER)
  )
  if (check.newDumps > 0) record('crash', 'crash.native', { count: check.newDumps })
  record('health', 'session.start', { consentJustGiven: false })
}

/** On before-quit: a clean end. Its absence for a session is what "crashed" means. */
export function recordQuit(): void {
  record('health', 'session.end', {})
}
