// Simple app-wide preferences, remembered locally (same localStorage pattern
// as consent/prefs.ts and live/useCueSettings.ts).

const KEY_AUTO_START_LISTENING = 'salesos.settings.autoStartListening'
const KEY_AUTO_OPEN_MEETING_PAGE = 'salesos.settings.autoOpenMeetingPage'
const KEY_AUTO_SUMMARIZE = 'salesos.settings.autoSummarize'
const KEY_AUTO_GENERATE_TITLE = 'salesos.settings.autoGenerateTitle'
const KEY_EXCLUDED_APPS = 'salesos.settings.excludedApps'
const KEY_SEEN_APPS = 'salesos.settings.seenApps'

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

function readStringArray(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(read(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
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

// Default ON: harmless UI conveniences with no cost or capture implications.
export function getAutoOpenMeetingPage(): boolean {
  return read(KEY_AUTO_OPEN_MEETING_PAGE) !== 'false'
}

export function setAutoOpenMeetingPage(value: boolean): void {
  write(KEY_AUTO_OPEN_MEETING_PAGE, String(value))
}

// Default OFF: unlike opening a page, this silently sends the transcript to
// Claude on every saved call — a real behavior + cost change, so it's opt-in
// rather than matching every toggle's default in the reference product.
export function getAutoSummarize(): boolean {
  return read(KEY_AUTO_SUMMARIZE) === 'true'
}

export function setAutoSummarize(value: boolean): void {
  write(KEY_AUTO_SUMMARIZE, String(value))
}

// Default OFF, same reasoning as auto-summarize (a Claude call per saved call).
export function getAutoGenerateTitle(): boolean {
  return read(KEY_AUTO_GENERATE_TITLE) === 'true'
}

export function setAutoGenerateTitle(value: boolean): void {
  write(KEY_AUTO_GENERATE_TITLE, String(value))
}

/** Apps excluded from auto-start (checked against the foreground app when a
 *  Live Calls auto-start would otherwise fire). */
export function getExcludedApps(): string[] {
  return readStringArray(KEY_EXCLUDED_APPS)
}

export function setExcludedApps(apps: string[]): void {
  write(KEY_EXCLUDED_APPS, JSON.stringify(apps))
}

/** Every app name ever observed in the foreground during a Live Calls
 *  session — populates the "Select apps" list (an app must have been seen at
 *  least once to appear, same as the Krisp reference). */
export function getSeenApps(): string[] {
  return readStringArray(KEY_SEEN_APPS)
}

export function addSeenApp(appName: string): void {
  const current = getSeenApps()
  if (!appName || current.includes(appName)) return
  write(KEY_SEEN_APPS, JSON.stringify([...current, appName].sort()))
}
