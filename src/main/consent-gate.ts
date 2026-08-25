// The durable consent gate (§5.3, acceptance criterion 11).
//
// Buyer capture was already triple-gated — a renderer check, a one-shot arm in
// main, and the Settings master switch — but all three were PROCESS STATE. The
// consent record itself lived in renderer memory for the length of the call
// and only reached disk when the call was saved.
//
// That distinction is the whole point of the criterion. "Capture cannot start
// without consent" has to be provable from something that outlives the process
// that claims it, because the failure being guarded against is a banner
// reading "recording in progress" while audio is already being written — and a
// flag in memory cannot tell that story afterwards, to anyone, ever.
//
// So consent is now written to disk BEFORE capture is armed, and the arm and
// the grant both read it back from disk. If the file is not there, or does not
// permit capture, the display-media request is refused. The renderer cannot
// talk main into it, because main never asks the renderer.
//
// The file is deliberately small, single-purpose and short-lived: one active
// call at a time, cleared when the call ends and on every app start (so a
// record left behind by a crash can never authorise the NEXT call).

import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { sanitizeConsent, type ConsentRecord } from './calls-fs'
import { signalConsentFlowError } from './telemetry/signals'

/**
 * M29 A2 — an aggregate counter for gate I/O failures (op + short fs code,
 * never the call id, never who, never the method). A consent write failing
 * is fail-closed and CORRECT — but today it is also invisible (audit §1.5),
 * and a spike of these in the field means people are being denied a
 * capability they said yes to. Wrapped in its own try even though record()
 * is proven never-throwing: in this file, a telemetry call must not be able
 * to alter a gate outcome under any circumstances, including ones the
 * telemetry module's own tests never imagined.
 */
function reportGateError(op: 'write' | 'read' | 'clear', err: unknown): void {
  try {
    const code = (err as { code?: unknown } | null)?.code
    signalConsentFlowError({
      op,
      code: typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined
    })
  } catch {
    /* never — but if ever, the gate's own behaviour is already decided */
  }
}

export interface ActiveConsent {
  /** M27 E1 — the CALL this consent belongs to, not the transcription
   *  session. A mono<->multichannel restart mid-call (turning buyer-capture
   *  on) mints a brand-new session id in main, but it is still the same
   *  call — keying on sessionId meant every consent check after that exact
   *  restart silently failed for the rest of the call (fail-safe, not a
   *  leak, but it defeated the feature the instant it was turned on). callId
   *  is the identifier this codebase already uses for "survives a session
   *  restart" elsewhere (see useDealIntelligence.ts/useLiveCues.ts's own
   *  BUG-055 fix) — this doc comment's own next line already described the
   *  invariant as call-scoped before the code did. */
  callId: string
  consent: ConsentRecord
  /** When it was written. Metadata for the audit trail, never a gate. */
  persistedAt: string
}

/** Overridable so the gate can be tested without an Electron app object. */
let baseDir: string | null = null

export function setConsentGateDirForTests(dir: string | null): void {
  baseDir = dir
}

function gatePath(): string {
  const dir = baseDir ?? app.getPath('userData')
  return join(dir, 'active-consent.json')
}

/**
 * Write the consent for the call about to start capturing. Synchronous on
 * purpose: the renderer calls this inside the click that opens
 * getDisplayMedia, and an async round-trip there would spend the user
 * activation the browser requires, so the capture prompt would never appear.
 * It is one small JSON file, once per call.
 *
 * Returns false when the record does not actually permit capture — the
 * sanitizer's invariant is applied here too, so a renderer that sent a
 * hand-built "consented" object without the flag gets nothing written.
 */
export function persistActiveConsent(callId: string, raw: unknown): boolean {
  const consent = sanitizeConsent(raw)
  if (consent.recordOtherParty !== true) {
    // Not an error — turning consent off legitimately lands here. Clear any
    // previous grant rather than leaving a stale one authorising capture.
    clearActiveConsent()
    return false
  }
  const payload: ActiveConsent = {
    callId,
    consent,
    persistedAt: new Date().toISOString()
  }
  try {
    const dir = baseDir ?? app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    writeFileSync(gatePath(), JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch (err) {
    // A gate that cannot be written is a gate that must not open.
    reportGateError('write', err) // M29 A2 — counted; the outcome is unchanged
    return false
  }
}

export function readActiveConsent(): ActiveConsent | null {
  try {
    const parsed = JSON.parse(readFileSync(gatePath(), 'utf8')) as Partial<ActiveConsent>
    const consent = sanitizeConsent(parsed?.consent)
    // Re-sanitized on READ as well as write, exactly like a saved call: a
    // hand-edited file claiming consent it never had collapses here.
    if (consent.recordOtherParty !== true) return null
    if (typeof parsed?.callId !== 'string' || !parsed.callId) return null
    return {
      callId: parsed.callId,
      consent,
      persistedAt: typeof parsed.persistedAt === 'string' ? parsed.persistedAt : ''
    }
  } catch (err) {
    // ENOENT is the NORMAL state (no active consent) and must not count —
    // only a file that exists but cannot be read/parsed is a flow error.
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') {
      reportGateError('read', err) // M29 A2 — counted; the outcome is unchanged
    }
    return null
  }
}

export function clearActiveConsent(): void {
  try {
    unlinkSync(gatePath())
  } catch (err) {
    /* already gone, which is the state we wanted */
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') {
      // Anything else (EPERM, EBUSY…) means a stale grant might LINGER —
      // the one direction this gate must never fail in. Counted.
      reportGateError('clear', err) // M29 A2 — behaviour unchanged
    }
  }
}

/**
 * The gate itself. True only when a record on disk genuinely permits capturing
 * the other party.
 *
 * When `callId` is supplied it must match, so consent recorded for one call
 * can never authorise the next — the case that matters is a rep who consented
 * on call A, hung up, and started call B without being asked again. M27 E1 —
 * deliberately NOT sessionId: a mono<->multichannel restart mid-call mints a
 * new session id for the SAME call, and a grant that couldn't survive that
 * restart silently stopped protecting anything for the rest of the call.
 */
export function consentPermitsCapture(callId?: string): boolean {
  const active = readActiveConsent()
  if (!active) return false
  if (typeof callId === 'string' && active.callId !== callId) return false
  return true
}
