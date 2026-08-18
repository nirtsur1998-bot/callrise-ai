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

/**
 * F-08 (renderer half). Mirrors `IsThirdPartyVirtualMic` in kern_bridge.cpp —
 * the SAME vendor list, kept in sync by hand across the two repos/languages.
 * Do not add a name to one without adding it to the other.
 *
 * kern_bridge's own comment on that function states as fact that "the
 * renderer applies the same rule when it chooses a name to hand us" — this
 * is that half of the contract. Before this existed, `resolveTier1MicName`
 * only excluded OUR OWN virtual mic (isCallRiseMic), so a machine whose
 * resolved input device was a competitor's virtual/denoising mic (observed
 * live: Krisp) would have Tier 1 tell kern_bridge to capture and denoise
 * that mic's ALREADY-denoised output as if it were real hardware — the
 * exact double-processing bug F-08 exists to prevent, reachable through the
 * one path kern_bridge's own auto-pick guard explicitly does not cover
 * (an explicitly-passed name, which it treats as "a legitimate deliberate
 * choice" and honours).
 */
const THIRD_PARTY_VIRTUAL_MIC_PATTERNS: RegExp[] = [
  /krisp/i,
  /vb-audio/i,
  /vb-cable/i,
  /cable output/i,
  /voicemeeter/i,
  /nvidia broadcast/i,
  /rtx voice/i,
  /virtual audio/i,
  /virtual cable/i,
  /virtual microphone/i,
  /obs virtual/i,
  /elgato wave/i,
  /steelseries sonar/i,
  /discord/i,
  /blackhole/i,
  /soundflower/i
]

export function isThirdPartyVirtualMic(label: string): boolean {
  return THIRD_PARTY_VIRTUAL_MIC_PATTERNS.some((re) => re.test(label))
}

/**
 * Target capture rate for transcription — NOT a quality knob, a bandwidth
 * one. `new AudioContext()` with no options runs at whatever the OS negotiates
 * for the default audio device, commonly 44.1/48kHz on Windows; nothing
 * downstream constrained it, so the raw, uncompressed linear16 PCM streamed to
 * Deepgram inherited that rate 1:1 (buildUrl() just does
 * `sample_rate: String(s.sampleRate)`). Multichannel (buyer capture) then
 * doubles that again for the second channel — so an unconstrained 48kHz
 * machine going stereo streams up to 6x the bytes/sec of a 16kHz mono one,
 * with zero benefit: Deepgram's Nova-3 (like virtually every modern ASR
 * model) is trained on ~16kHz speech and gets no more accurate from a wider
 * band. On a machine with less upload headroom than dev/CI, that padding is
 * exactly the kind of thing that only becomes visible once buyer capture
 * turns the multiplier on.
 */
export const TRANSCRIPTION_SAMPLE_RATE = 16000

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

// The mic hook is mounted more than once at a time (the Home card and the
// Copilot panel). localStorage is shared but React state is not, so a
// self-heal in one instance would leave the other dropdown displaying a device
// that is no longer the one being recorded. These let every live instance hear
// about a change, whoever made it.
type MicListener = (id: string) => void
const micListeners = new Set<MicListener>()

export function subscribeSelectedMic(fn: MicListener): () => void {
  micListeners.add(fn)
  return () => {
    micListeners.delete(fn)
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
  // Notify AFTER the write, and never let a listener's failure break the save.
  for (const fn of micListeners) {
    try {
      fn(id)
    } catch {
      /* a subscriber blowing up must not affect the others */
    }
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
 * `exact`) throughout — for the device, so a missing/unplugged one falls back
 * to the system default instead of throwing; for sampleRate, because the
 * AudioContext (recorder.ts) resamples to its own rate regardless, so this is
 * a best-effort request to let the OS/driver capture at the lower rate
 * directly rather than something that must succeed. Mono + the usual cleanup,
 * matching the original capture.
 *
 * The soft device `ideal` is why a stale id is dangerous rather than merely
 * broken — useAudioDevices repairs the stored id on every enumeration so the
 * id read here is one that actually exists.
 */
export function getMicConstraints(): MediaTrackConstraints {
  const id = getSelectedMicId()
  return {
    channelCount: 1,
    sampleRate: { ideal: TRANSCRIPTION_SAMPLE_RATE },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(id ? { deviceId: { ideal: id } } : {})
  }
}
