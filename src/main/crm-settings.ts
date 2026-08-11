// CRM Phase 1 settings — calendar-match sensitivity/kill-switch, default
// country, and auto-numbered customer IDs. Same sanitize/merge/defaults
// pattern as personalization-context.ts.

export type MatchSensitivity = 'tight' | 'normal' | 'loose'

export interface CrmSettings {
  /** Master kill switch for the calendar-match suggestion banner. */
  calendarMatchEnabled: boolean
  /** How wide the time window is when matching a call to a calendar event. */
  matchSensitivity: MatchSensitivity
  /** Opt-in: auto-link when there's exactly one unambiguous match to an
   *  EXISTING contact. Never auto-creates a contact. */
  autoLinkUnambiguous: boolean
  /** ISO 3166-1 alpha-2, or '' for none — pre-fills new contacts' country. */
  defaultCountry: string
  autoNumberCid: boolean
  cidPrefix: string
  /** The next sequential number to assign (incremented on each auto-assign). */
  cidNextNumber: number
  /** Master kill switch for "needs follow-up" flagging on deals (Phase 4
   *  Step 1) — the badge, and the "Create follow-up task" button. Off means
   *  the feature is fully invisible, not just visually muted. */
  staleFollowUpEnabled: boolean
  /** A deal is flagged once its contact's last call is older than this many
   *  days (or there's never been a call at all). */
  staleAfterDays: number
  /** Opt-in: when a call gets linked to a contact (and has a transcript),
   *  send it to Claude for a short CRM note appended to that contact —
   *  same "sends data to Claude automatically" cost/privacy tradeoff as
   *  auto-summarize, so default OFF. */
  autoGenerateNotes: boolean
  /** M23 Workstream C — master switch for the standalone "Generate CRM
   *  note" card on the Contact page (on-demand note draft + KYC-fact
   *  harvest with accept/reject chips). Off (default) means that card
   *  doesn't render at all — the Contact page looks exactly as it did
   *  before this workstream. Independent of autoGenerateNotes above (that
   *  one is the automatic, no-click background path). */
  noteGeneratorEnabled: boolean
}

export const EMPTY_CRM_SETTINGS: CrmSettings = {
  calendarMatchEnabled: true,
  matchSensitivity: 'normal',
  autoLinkUnambiguous: false,
  defaultCountry: '',
  autoNumberCid: false,
  cidPrefix: 'CUST-',
  cidNextNumber: 1,
  staleFollowUpEnabled: true,
  staleAfterDays: 14,
  autoGenerateNotes: false,
  noteGeneratorEnabled: false
}

const SENSITIVITIES = new Set<MatchSensitivity>(['tight', 'normal', 'loose'])
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/
const MAX_PREFIX = 20

function sanitizeCountry(value: unknown): string {
  return typeof value === 'string' && COUNTRY_CODE_RE.test(value) ? value.toUpperCase() : ''
}

function sanitizeSensitivity(value: unknown): MatchSensitivity {
  return typeof value === 'string' && SENSITIVITIES.has(value as MatchSensitivity)
    ? (value as MatchSensitivity)
    : 'normal'
}

function sanitizePrefix(value: unknown): string {
  const clean = typeof value === 'string' ? value.trim().slice(0, MAX_PREFIX) : ''
  return clean || 'CUST-'
}

function sanitizeNextNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
}

const MIN_STALE_DAYS = 1
const MAX_STALE_DAYS = 365

function sanitizeStaleDays(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), MIN_STALE_DAYS), MAX_STALE_DAYS)
    : 14
}

/** Full sanitize — used when reading the settings file from disk. */
export function sanitizeCrmSettings(value: unknown): CrmSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    calendarMatchEnabled: v.calendarMatchEnabled !== false, // default true
    matchSensitivity: sanitizeSensitivity(v.matchSensitivity),
    autoLinkUnambiguous: v.autoLinkUnambiguous === true,
    defaultCountry: sanitizeCountry(v.defaultCountry),
    autoNumberCid: v.autoNumberCid === true,
    cidPrefix: sanitizePrefix(v.cidPrefix),
    cidNextNumber: sanitizeNextNumber(v.cidNextNumber),
    staleFollowUpEnabled: v.staleFollowUpEnabled !== false, // default true
    staleAfterDays: sanitizeStaleDays(v.staleAfterDays),
    autoGenerateNotes: v.autoGenerateNotes === true, // default false
    noteGeneratorEnabled: v.noteGeneratorEnabled === true // default false
  }
}

/** Partial-patch merge — only the keys present in `patch` are touched. */
export function mergeCrmSettings(current: CrmSettings, patch: unknown): CrmSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    calendarMatchEnabled:
      'calendarMatchEnabled' in p ? p.calendarMatchEnabled !== false : current.calendarMatchEnabled,
    matchSensitivity:
      'matchSensitivity' in p ? sanitizeSensitivity(p.matchSensitivity) : current.matchSensitivity,
    autoLinkUnambiguous:
      'autoLinkUnambiguous' in p ? p.autoLinkUnambiguous === true : current.autoLinkUnambiguous,
    defaultCountry:
      'defaultCountry' in p ? sanitizeCountry(p.defaultCountry) : current.defaultCountry,
    autoNumberCid: 'autoNumberCid' in p ? p.autoNumberCid === true : current.autoNumberCid,
    cidPrefix: 'cidPrefix' in p ? sanitizePrefix(p.cidPrefix) : current.cidPrefix,
    cidNextNumber:
      'cidNextNumber' in p ? sanitizeNextNumber(p.cidNextNumber) : current.cidNextNumber,
    staleFollowUpEnabled:
      'staleFollowUpEnabled' in p ? p.staleFollowUpEnabled !== false : current.staleFollowUpEnabled,
    staleAfterDays:
      'staleAfterDays' in p ? sanitizeStaleDays(p.staleAfterDays) : current.staleAfterDays,
    autoGenerateNotes:
      'autoGenerateNotes' in p ? p.autoGenerateNotes === true : current.autoGenerateNotes,
    noteGeneratorEnabled:
      'noteGeneratorEnabled' in p ? p.noteGeneratorEnabled === true : current.noteGeneratorEnabled
  }
}

/** The actual time-window buffer (ms) for a given sensitivity — the single
 *  source of truth calendarMatch.ts's findCalendarMatches() applies. */
export function matchSensitivityMs(sensitivity: MatchSensitivity): number {
  switch (sensitivity) {
    case 'tight':
      return 5 * 60 * 1000
    case 'loose':
      return 30 * 60 * 1000
    default:
      return 15 * 60 * 1000
  }
}
