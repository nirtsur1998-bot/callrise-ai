/**
 * Registry of known conferencing apps, keyed by a normalized `appId`.
 *
 * This is the single place that maps platform-specific identifiers (macOS
 * bundle IDs, Windows exe basenames, window-title patterns) to the normalized
 * `appId`/`displayName` pair used everywhere else in detection. Extending
 * support for a new app means adding one entry here - see docs/detection.md
 * once Phase 5 lands.
 *
 * Browsers (Chrome/Edge/Safari) are deliberately process-only entries with no
 * title patterns of their own: a browser process running is a weak `process`
 * signal, but a browser *window titled* "Meet - ..." is what actually raises
 * confidence, via the browser-hosted apps' `titlePatterns` below.
 */
export interface ConferencingAppEntry {
  appId: string
  displayName: string
  /** macOS bundle identifiers, e.g. 'us.zoom.xos'. */
  macBundleIds?: string[]
  /** Windows executable basenames, lowercase, e.g. 'zoom.exe'. */
  windowsExeNames?: string[]
  /** Process names as reported by active-win's `owner.name` (cross-platform fallback). */
  processNames?: string[]
  /** Window/tab title patterns that indicate an active call in this app. */
  titlePatterns?: RegExp[]
}

export const CONFERENCING_APPS: ConferencingAppEntry[] = [
  {
    appId: 'zoom',
    displayName: 'Zoom',
    macBundleIds: ['us.zoom.xos'],
    windowsExeNames: ['zoom.exe'],
    processNames: ['zoom', 'zoom.us'],
    titlePatterns: [/zoom meeting/i, /^zoom\b/i]
  },
  {
    appId: 'teams',
    displayName: 'Microsoft Teams',
    macBundleIds: ['com.microsoft.teams2', 'com.microsoft.teams'],
    windowsExeNames: ['ms-teams.exe', 'teams.exe'],
    processNames: ['microsoft teams', 'teams'],
    titlePatterns: [/\|\s*microsoft teams/i, /^microsoft teams/i]
  },
  {
    appId: 'meet',
    displayName: 'Google Meet',
    processNames: ['google meet'],
    titlePatterns: [/meet\s*-\s*/i, /google meet/i]
  },
  {
    appId: 'slack',
    displayName: 'Slack',
    macBundleIds: ['com.tinyspeck.slackmacgap'],
    windowsExeNames: ['slack.exe'],
    processNames: ['slack'],
    titlePatterns: [/huddle/i]
  },
  {
    appId: 'webex',
    displayName: 'Webex',
    macBundleIds: ['com.cisco.webexmeetingsapp'],
    windowsExeNames: ['ciscocollabhost.exe', 'webexmta.exe'],
    processNames: ['webex', 'cisco webex'],
    titlePatterns: [/webex/i]
  },
  {
    appId: 'facetime',
    displayName: 'FaceTime',
    macBundleIds: ['com.apple.facetime'],
    processNames: ['facetime']
  },
  {
    appId: 'skype',
    displayName: 'Skype',
    windowsExeNames: ['skype.exe'],
    processNames: ['skype']
  },
  {
    appId: 'discord',
    displayName: 'Discord',
    windowsExeNames: ['discord.exe'],
    processNames: ['discord']
  },
  {
    appId: 'gotomeeting',
    displayName: 'GoToMeeting',
    processNames: ['gotomeeting']
  },
  {
    appId: 'ringcentral',
    displayName: 'RingCentral',
    processNames: ['ringcentral']
  },
  {
    appId: 'dialpad',
    displayName: 'Dialpad',
    processNames: ['dialpad']
  },
  {
    appId: 'whatsapp',
    displayName: 'WhatsApp',
    // Confirmed on real Windows hardware (detect:debug, 2026-07-27): the modern
    // Store-packaged WhatsApp Windows app's actual process is 'WhatsApp.root.exe',
    // not 'whatsapp' - without this it silently never matched, capping every
    // WhatsApp call at the unknown-app 0.25 weight forever (never detectable).
    windowsExeNames: ['whatsapp.exe', 'whatsapp.root.exe'],
    processNames: ['whatsapp']
  },
  {
    appId: 'microsip',
    displayName: 'MicroSIP',
    windowsExeNames: ['microsip.exe'],
    processNames: ['microsip']
  },
  {
    appId: 'zoiper',
    displayName: 'Zoiper',
    processNames: ['zoiper']
  },
  {
    appId: '3cx',
    displayName: '3CX',
    processNames: ['3cx']
  }
]

/** Process names that identify one of OUR OWN processes - never a call, and must never self-trigger detection. */
export const OWN_PROCESS_NAMES = ['callrise ai', 'callrise', 'salesos-virtualmic']

/**
 * Our own app's bundle id (electron-builder.yml `appId`). Electron is
 * multi-process (main/renderer/GPU/utility all have distinct pids), so a
 * single "our pid" check misses child processes - e.g. the renderer process
 * that actually holds `getUserMedia`. Matching by bundle id catches every one
 * of our own processes regardless of which one CoreAudio reports as the
 * active input, without needing to enumerate Electron's child pids.
 */
export const OWN_BUNDLE_IDS = ['ai.callrise.app']

const byAppId = new Map(CONFERENCING_APPS.map((entry) => [entry.appId, entry]))

export function getConferencingApp(appId: string): ConferencingAppEntry | undefined {
  return byAppId.get(appId)
}

export function isKnownConferencingApp(appId: string): boolean {
  return byAppId.has(appId)
}

/**
 * Resolve a raw OS identifier (macOS bundle id, Windows exe basename, or a
 * generic process/owner name) to a normalized appId + displayName. Falls back
 * to `unknown:<name>` when nothing matches, per the DetectionSignal contract.
 */
export function normalizeAppIdentity(input: {
  macBundleId?: string
  windowsExeName?: string
  processName?: string
}): { appId: string; displayName: string; known: boolean } {
  const exe = input.windowsExeName?.toLowerCase()
  const bundle = input.macBundleId?.toLowerCase()
  const proc = input.processName?.toLowerCase()

  for (const entry of CONFERENCING_APPS) {
    if (bundle && entry.macBundleIds?.some((id) => id.toLowerCase() === bundle)) {
      return { appId: entry.appId, displayName: entry.displayName, known: true }
    }
    if (exe && entry.windowsExeNames?.some((name) => name.toLowerCase() === exe)) {
      return { appId: entry.appId, displayName: entry.displayName, known: true }
    }
    if (proc && entry.processNames?.some((name) => name.toLowerCase() === proc)) {
      return { appId: entry.appId, displayName: entry.displayName, known: true }
    }
  }

  const fallbackName = input.processName ?? input.windowsExeName ?? input.macBundleId ?? 'unknown'
  return { appId: `unknown:${fallbackName.toLowerCase()}`, displayName: fallbackName, known: false }
}

/** Does this title match a known conferencing app's title pattern? Returns the matching app, if any. */
export function matchTitle(title: string): ConferencingAppEntry | undefined {
  return CONFERENCING_APPS.find((entry) =>
    entry.titlePatterns?.some((pattern) => pattern.test(title))
  )
}

/**
 * Generic "does this window title look like a call" fallback for apps with
 * NO registry entry at all (M17 §2.2 — an unlisted app must still be
 * detectable). Only reached when matchTitle() above already found nothing —
 * this is deliberately conservative (explicit call/meeting words only, no
 * bare timer-pattern matching) since a false hit here contributes directly
 * to detection confidence for an app we have zero other information about.
 * Kept as its own function (not folded into CONFERENCING_APPS) so it's easy
 * to find, tune, and unit-test in isolation as false-positive reports come in.
 */
const GENERIC_CALL_TITLE_PATTERNS: RegExp[] = [
  /\bcall\b/i,
  /\bmeeting\b/i,
  /\bconference\b/i,
  /\bvideo\s*chat\b/i,
  /\bhuddle\b/i,
  /\bwebinar\b/i,
  /\bvoip\b/i,
  /\bdialer\b/i,
  /\bon\s+a\s+call\b/i,
  /\bin\s+a\s+meeting\b/i
]

export function looksLikeCallTitle(title: string): boolean {
  return GENERIC_CALL_TITLE_PATTERNS.some((pattern) => pattern.test(title))
}

/** True if this process (by pid, bundle id, or name) is one of our own - must be excluded before it ever reaches fusion. */
export function isOwnProcess(input: {
  pid?: number
  ourPid?: number
  bundleId?: string
  processName?: string
}): boolean {
  if (input.pid != null && input.ourPid != null && input.pid === input.ourPid) return true
  if (input.bundleId && OWN_BUNDLE_IDS.includes(input.bundleId.toLowerCase())) return true
  if (input.processName) {
    const lower = input.processName.toLowerCase()
    return OWN_PROCESS_NAMES.some((name) => lower.includes(name))
  }
  return false
}
