// First-run onboarding state, remembered locally — same localStorage pattern as
// settings/prefs.ts, consent/prefs.ts and live/useCueSettings.ts. Per-device
// (not per-account) on purpose: it mirrors how every other UI preference in the
// app is stored, so a user on a new machine simply gets the quick setup again.

const KEY_COMPLETED_AT = 'salesos.onboarding.completedAt'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* localStorage unavailable — treat onboarding as done this session */
  }
}

/** Has the user finished (or skipped) onboarding on this device? */
export function isOnboardingComplete(): boolean {
  return !!read(KEY_COMPLETED_AT)
}

/** Mark onboarding done. Called on both "finish" and "skip" so it never nags. */
export function markOnboardingComplete(): void {
  write(KEY_COMPLETED_AT, new Date().toISOString())
}

/** Settings' "Replay setup" action — clears the completed flag so App's
 *  onboarding gate shows OnboardingFlow again on the next mount. Saved
 *  personalization/consent/cue values still pre-fill each step (see
 *  useOnboarding's prefill effect), so this is a guided review, not a
 *  destructive reset. */
export function clearOnboardingComplete(): void {
  try {
    localStorage.removeItem(KEY_COMPLETED_AT)
  } catch {
    /* localStorage unavailable — nothing to clear */
  }
}
