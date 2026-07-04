// Audio-device preferences. The chosen microphone is a renderer-only setting
// (localStorage) applied when a call starts. Output routing is intentionally NOT
// here — the app can't reroute where the *call* plays (that's a macOS setting);
// we only choose which mic we record.

const MIC_KEY = 'salesos.audio.micDeviceId'

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
 * `exact`) so a missing/unplugged device falls back to the system default
 * instead of throwing. Mono + the usual cleanup, matching the original capture.
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
