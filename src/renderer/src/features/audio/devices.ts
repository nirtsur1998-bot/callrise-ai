// Audio-device preferences. The chosen microphone is a renderer-only setting
// (localStorage) applied when a call starts. Output routing is intentionally NOT
// here — the app can't reroute where the *call* plays (that's a macOS setting);
// we only choose which mic we record.

const MIC_KEY = 'salesos.audio.micDeviceId'
// M21: the LABEL of the chosen mic, stored alongside its id.
//
// A browser deviceId is not a stable identity — reinstalling the audio driver
// mints new device GUIDs while the friendly name stays the same. Because the
// capture constraint uses `ideal` (a soft hint, deliberately, so an unplugged
// mic doesn't throw), a stale id doesn't fail: the OS quietly hands back a
// DIFFERENT microphone and nothing anywhere says so. Keeping the label lets a
// stale id be re-resolved to the same physical device instead (BUG-005).
const MIC_LABEL_KEY = 'salesos.audio.micDeviceLabel'
// Marks that the user has DELIBERATELY chosen something — including "System
// default", which is stored as an empty id and is otherwise byte-for-byte
// identical to "never chosen". Without this, auto-selecting the denoising mic
// would silently override an explicit System-default choice.
const MIC_CHOSEN_KEY = 'salesos.audio.micChosen'

/** Names the noise-cancelling virtual mic goes by. The macOS device kept its
 *  pre-rebrand name ("Sales OS Microphone") on purpose so existing setups
 *  weren't orphaned; Windows exposes the denoised endpoint under the mic-array
 *  names the driver registers. */
const CALLRISE_MIC_PATTERNS: RegExp[] = [
  /sales\s*os\s*microphone/i,
  /callrise/i,
  /internal microphone array/i
]

export function isCallRiseMic(label: string): boolean {
  return CALLRISE_MIC_PATTERNS.some((re) => re.test(label))
}

export function getSelectedMicId(): string {
  try {
    return window.localStorage.getItem(MIC_KEY) ?? ''
  } catch {
    return ''
  }
}

export function getSelectedMicLabel(): string {
  try {
    return window.localStorage.getItem(MIC_LABEL_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setSelectedMic(id: string, label = '', explicit?: boolean): void {
  try {
    window.localStorage.setItem(MIC_KEY, id)
    if (label) window.localStorage.setItem(MIC_LABEL_KEY, label)
    else window.localStorage.removeItem(MIC_LABEL_KEY)
    // Only a real user action sets this; the self-heal writes leave it alone.
    if (explicit) window.localStorage.setItem(MIC_CHOSEN_KEY, '1')
  } catch {
    /* best-effort: a non-critical preference */
  }
}

/** Has the user ever deliberately picked a microphone (including "System
 *  default")? Auto-selection must never override that. */
export function hasExplicitMicChoice(): boolean {
  try {
    return window.localStorage.getItem(MIC_CHOSEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Back-compat alias — callers that only know the id. */
export function setSelectedMicId(id: string): void {
  setSelectedMic(id, '')
}

export interface MicChoice {
  deviceId: string
  label: string
}

export type MicResolution =
  /** The saved device is present under the same id. Nothing to do. */
  | { status: 'ok'; deviceId: string; label: string }
  /** The saved id is gone but a device with the same NAME is present — the
   *  driver-reinstall case. The stored id is repaired to point at it. */
  | { status: 'repaired'; deviceId: string; label: string }
  /** Nothing was chosen and the denoising mic is available, so it is picked. */
  | { status: 'auto-callrise'; deviceId: string; label: string }
  /** A device was chosen but is not available under any id or name. Capture
   *  will fall back to the system default — the user needs telling. */
  | { status: 'missing'; deviceId: ''; label: string }
  /** Nothing chosen, nothing to auto-pick: the system default is correct. */
  | { status: 'none'; deviceId: ''; label: '' }

/**
 * Work out which microphone to actually record from.
 *
 * Pure so it can be tested without a browser: `available` is whatever
 * enumerateDevices() returned. Resolution order matters — an explicit choice
 * that is still present always wins over auto-selection, so this never
 * overrides a deliberate pick.
 */
export function resolveMic(
  saved: { deviceId: string; label: string; explicit?: boolean },
  available: MicChoice[],
  opts?: { preferCallRise?: boolean }
): MicResolution {
  const byId = available.find((d) => d.deviceId === saved.deviceId)
  if (saved.deviceId && byId) return { status: 'ok', deviceId: byId.deviceId, label: byId.label }

  // Same name, new id: the device is the same one, its id just changed.
  if (saved.label) {
    const byLabel = available.find((d) => d.label === saved.label)
    if (byLabel) {
      return { status: 'repaired', deviceId: byLabel.deviceId, label: byLabel.label }
    }
  }

  // Only auto-pick when the user has not chosen anything. Auto-selecting over
  // a deliberate choice would be its own silent-wrong-mic bug — and "System
  // default" IS a deliberate choice even though it stores an empty id, which is
  // why an explicit-choice marker is needed rather than just testing the id.
  if (!saved.deviceId && !saved.explicit && opts?.preferCallRise) {
    const callrise = available.find((d) => isCallRiseMic(d.label))
    if (callrise) {
      return { status: 'auto-callrise', deviceId: callrise.deviceId, label: callrise.label }
    }
  }

  if (saved.deviceId) return { status: 'missing', deviceId: '', label: saved.label }
  return { status: 'none', deviceId: '', label: '' }
}

/**
 * getUserMedia audio constraints honoring the chosen mic. Uses `ideal` (not
 * `exact`) so a missing/unplugged device falls back to the system default
 * instead of throwing. Mono + the usual cleanup, matching the original capture.
 *
 * The soft `ideal` is why a stale id is dangerous rather than merely broken —
 * useAudioDevices repairs the stored id on every enumeration so the id read
 * here is one that actually exists.
 */
export function getMicConstraints(): MediaTrackConstraints {
  const id = getSelectedMicId()
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(id ? { deviceId: { ideal: id } } : {})
  }
}
