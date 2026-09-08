// Simple app-wide preferences, remembered locally (same localStorage pattern
// as consent/prefs.ts and live/useCueSettings.ts).

const KEY_AUTO_START_LISTENING = 'salesos.settings.autoStartListening'
const KEY_AUTO_OPEN_MEETING_PAGE = 'salesos.settings.autoOpenMeetingPage'
const KEY_AUTO_SUMMARIZE = 'salesos.settings.autoSummarize'
const KEY_AUTO_GENERATE_TITLE = 'salesos.settings.autoGenerateTitle'
const KEY_AUTO_POST_CALL_BRIEF = 'salesos.settings.autoPostCallBrief'
const KEY_EXCLUDED_APPS = 'salesos.settings.excludedApps'
const KEY_SEEN_APPS = 'salesos.settings.seenApps'
const KEY_AUTO_TRANSCRIBE_CALLS = 'salesos.settings.autoTranscribeCalls'
const KEY_TIER1_ENABLED = 'salesos.settings.tier1Enabled'

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

/* ── BUG-227: the three AI Note Taker prefs no longer live here ───────────
 *
 * getAutoSummarize / getAutoGenerateTitle / getAutoPostCallBrief are GONE.
 * They live in the settings file now, as `settings.aiNoteTaker` — read
 * through window.api.settings, written through settings.update, and therefore
 * backed up, readable by main, and immune to an origin change.
 *
 * WHY, in one measurement: localStorage is PER-ORIGIN. The founder set these
 * in the packaged app (file://); their daily driver is the dev app
 * (http://localhost:5173). Both share userData, so every OTHER setting
 * followed them across and these three did not. 137 of 191 calls went
 * untitled over five weeks, on a feature they believed was on, with nothing
 * anywhere reporting it off.
 *
 * The functions are DELETED rather than deprecated on purpose. A getter left
 * behind is a second source of truth, and the next person needing this value
 * would reach for whichever one compiles.
 *
 * What remains is the one-time SEED — the only thing that still reads the old
 * keys, and the only reason they are still named in this file.
 * ──────────────────────────────────────────────────────────────────────── */

/** Set once per ORIGIN, after that origin's seed has run. Deliberately in
 *  localStorage rather than in the settings file: the marker has to be
 *  per-origin, because each origin holds a different set of legacy values and
 *  each needs its own chance to contribute them. A marker in the shared
 *  settings file would let whichever app launched first speak for both. */
const KEY_AI_NOTE_TAKER_SEEDED = 'salesos.settings.aiNoteTakerSeeded'

export interface LegacyAiNoteTakerPrefs {
  autoSummarize: boolean
  autoGenerateTitle: boolean
  autoPostCallBrief: boolean
}

/**
 * BUG-227's migration. Reads the three legacy localStorage keys for THIS
 * origin, marks the origin seeded, and hands back what it found — or null if
 * this origin has already had its turn.
 *
 * The caller must only ever turn a preference ON from this. That is the whole
 * safety property, and it is what makes seeding from two origins correct
 * rather than destructive: the dev app finds nothing and changes nothing; the
 * packaged app, on its next launch, finds the founder's real settings and
 * restores them. A seed that could also turn things OFF would let the first
 * app to start silently clear the other's settings — a fresh version of the
 * bug this migration exists to end.
 */
export function takeLegacyAiNoteTakerPrefs(): LegacyAiNoteTakerPrefs | null {
  if (read(KEY_AI_NOTE_TAKER_SEEDED) === 'true') return null
  const legacy = {
    autoSummarize: read(KEY_AUTO_SUMMARIZE) === 'true',
    autoGenerateTitle: read(KEY_AUTO_GENERATE_TITLE) === 'true',
    autoPostCallBrief: read(KEY_AUTO_POST_CALL_BRIEF) === 'true'
  }
  // Written whether or not anything was found: an origin with nothing to
  // contribute has still had its turn, and re-reading three keys that will
  // never change again costs a launch-time round trip for nothing.
  write(KEY_AI_NOTE_TAKER_SEEDED, 'true')
  return legacy
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

// Default OFF: skips the "we noticed a call — want to transcribe it?" prompt
// and starts listening immediately instead — a real capture-without-asking
// behavior change, so it stays opt-in like auto-start-listening above.
export function getAutoTranscribeCalls(): boolean {
  return read(KEY_AUTO_TRANSCRIBE_CALLS) === 'true'
}

export function setAutoTranscribeCalls(value: boolean): void {
  write(KEY_AUTO_TRANSCRIBE_CALLS, String(value))
}

// Default OFF: a first run that silently reroutes someone's microphone
// through a new engine is a support ticket, not a nicety. Same reasoning as
// every other opt-in above — this is a real behavior change (which audio a
// stranger's engine processes), not a harmless default.
//
// recorder.ts reads this at the START of each call, not continuously —
// Tier 1 is per-call (spawned and torn down with the call itself), unlike
// macOS's Tier 2 virtual-mic driver which is a persistent system device.
// Flipping this ON while no call is active has nothing to start yet; it
// takes effect on the NEXT call. The settings card's copy must say this
// plainly rather than implying an on/off switch with instant effect.
export function getTier1Enabled(): boolean {
  return read(KEY_TIER1_ENABLED) === 'true'
}

export function setTier1Enabled(value: boolean): void {
  write(KEY_TIER1_ENABLED, String(value))
}

export type DenoiseStrength = 'low' | 'medium' | 'high'

/**
 * How hard Tier 1 denoises, as the attenuation limit handed to kern_bridge
 * (`--atten <db>`). Values extracted from the prototype build and kept:
 * 12/20 sit well above the ~3dB floor where libDF mixes back >70% of the
 * noisy signal, so all three settings are genuinely distinct. `high` maps to
 * NO argument at all — the engine's compiled-in 100dB ("no mix-back") stays
 * the single source of truth rather than being restated here where it could
 * drift.
 */
export const DENOISE_ATTEN_DB: Record<DenoiseStrength, number | null> = {
  low: 12,
  medium: 20,
  high: null
}

const KEY_TIER1_STRENGTH = 'salesos.settings.tier1Strength'

// Default HIGH, unlike the feature toggle's default-off: strength only
// matters once the user has already opted in, and someone who turned noise
// cancellation ON wants it to work — a timid default here would read as "the
// feature barely does anything" rather than as caution.
export function getDenoiseStrength(): DenoiseStrength {
  const v = read(KEY_TIER1_STRENGTH)
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'high'
}

export function setDenoiseStrength(value: DenoiseStrength): void {
  write(KEY_TIER1_STRENGTH, value)
}
