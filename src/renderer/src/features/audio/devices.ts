// Audio-device preferences. The chosen microphone is a renderer-only setting
// (localStorage) applied when a call starts. Output routing is intentionally NOT
// here — the app can't reroute where the *call* plays (that's a macOS setting);
// we only choose which mic we record.

const MIC_KEY = 'salesos.audio.micDeviceId'

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

export function setSelectedMicId(id: string): void {
  try {
    window.localStorage.setItem(MIC_KEY, id)
  } catch {
    /* best-effort: a non-critical preference */
  }
}

/**
 * getUserMedia audio constraints honoring the chosen mic. Uses `ideal` (not
 * `exact`) throughout — for the device, so a missing/unplugged one falls back
 * to the system default instead of throwing; for sampleRate, because the
 * AudioContext (recorder.ts) resamples to its own rate regardless, so this is
 * a best-effort request to let the OS/driver capture at the lower rate
 * directly rather than something that must succeed. Mono + the usual cleanup,
 * matching the original capture.
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
