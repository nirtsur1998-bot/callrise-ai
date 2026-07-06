// Simple app-wide preferences, remembered locally (same localStorage pattern
// as consent/prefs.ts and live/useCueSettings.ts).

const KEY_AUTO_START_LISTENING = 'salesos.settings.autoStartListening'

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
    /* localStorage unavailable — just use the in-memory value this session */
  }
}

// Default OFF: this app is deliberately careful about anything that starts
// capture without an explicit action, so auto-start is opt-in, not opt-out.
export function getAutoStartListening(): boolean {
  return read(KEY_AUTO_START_LISTENING) === 'true'
}

export function setAutoStartListening(value: boolean): void {
  write(KEY_AUTO_START_LISTENING, String(value))
}
