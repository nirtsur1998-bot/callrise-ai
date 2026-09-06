/**
 * BUG-190 (M35 Stage 2 walk, 2026-09-05) — the one place that decides what a
 * failed microphone request MEANS and what it is CALLED.
 *
 * On a clean machine with no audio input device the app said three different
 * things for one condition: the setup wizard said "Microphone access wasn't
 * granted" and pointed at OS privacy settings (wrong — no prompt had appeared,
 * there was no device to ask about); the live view said "No microphone found"
 * (right); the Audio page printed the browser's raw string ("Requested device
 * not found"). A stranger followed the wizard's wording into Windows privacy
 * settings, where nothing was wrong, and had nowhere to go.
 *
 * Every site that calls getUserMedia now classifies its error here and uses
 * these sentences. `osSettingsHelp` is true ONLY for a refused permission —
 * the single outcome where privacy settings are the answer.
 */

export type MicFailure = 'no-device' | 'denied' | 'busy' | 'error'
export type MicOutcome = 'ok' | MicFailure

/** Map a getUserMedia rejection to what it means. Names per the Media Capture
 *  spec: NotFoundError / OverconstrainedError = no matching device;
 *  NotAllowedError / SecurityError = permission; NotReadableError / AbortError
 *  = the device exists but could not be opened (typically held by another
 *  app). Anything else — including non-DOMException throws — is 'error'. */
export function classifyMicError(err: unknown): MicFailure {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy'
  return 'error'
}

export interface MicOutcomeText {
  title: string
  body: string
  /** Offer the "Open OS settings" link. Only permission is fixed there. */
  osSettingsHelp: boolean
}

export const MIC_OUTCOME_TEXT: Record<MicFailure, MicOutcomeText> = {
  'no-device': {
    title: 'No microphone found',
    body: 'Connect a microphone, then try again. You can finish setup without one — a live call will need it later.',
    osSettingsHelp: false
  },
  denied: {
    title: "Microphone access wasn't granted",
    body: 'You can still use CallRise, but a live call will need this later. Try again, or allow it from your OS privacy settings and re-check.',
    osSettingsHelp: true
  },
  busy: {
    title: 'Your microphone is being used by another app',
    body: 'Close the other app, then try again.',
    osSettingsHelp: false
  },
  error: {
    title: 'Could not start the microphone',
    body: 'Please try again.',
    osSettingsHelp: false
  }
}

export interface InputDeviceLike {
  deviceId: string
  label: string
}

const DEFAULT_PREFIX = /^Default\s*-\s*/i
const COMMS_PREFIX = /^Communications\s*-\s*/i

/**
 * Chromium enumerates the system default input twice more than it exists:
 * `default` ("Default - X") and `communications` ("Communications - X") on
 * top of X itself. The walk's selector listed one Remote Desktop microphone
 * three times. Drop the aliases whenever the real device is in the list; keep
 * `default` (prefix stripped) only when it is all there is — an unlabeled
 * list (no permission yet) is left untouched.
 */
export function dedupeInputDevices<T extends InputDeviceLike>(list: readonly T[]): T[] {
  const real = list.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  const realLabels = new Set(real.map((d) => d.label))
  const out: T[] = []
  for (const d of list) {
    if (d.deviceId === 'communications') continue
    if (d.deviceId === 'default') {
      const bare = d.label.replace(DEFAULT_PREFIX, '')
      if (realLabels.has(bare)) continue
      if (real.length > 0) continue
      out.push({ ...d, label: bare })
      continue
    }
    out.push({ ...d, label: d.label.replace(COMMS_PREFIX, '') })
  }
  return out
}

export interface MicSelectorOption {
  value: string
  label: string
  disabled: boolean
}

/** What a microphone <select> shows. "System default" is a promise that
 *  something will be used; with no inputs at all it is not offered. */
export function micSelectorOptions(mics: readonly InputDeviceLike[]): MicSelectorOption[] {
  if (mics.length === 0) return [{ value: '', label: MIC_OUTCOME_TEXT['no-device'].title, disabled: true }]
  return [
    { value: '', label: 'System default', disabled: false },
    ...mics.map((m) => ({ value: m.deviceId, label: m.label, disabled: false }))
  ]
}
