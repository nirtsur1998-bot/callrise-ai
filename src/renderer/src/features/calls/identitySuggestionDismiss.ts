// M23 Workstream D — per-call dismissal for IdentityContactSuggestion,
// intentionally a SEPARATE localStorage list from
// contacts/calendarMatch.ts's calendar-match dismissal. They used to share
// one key/list (both gated the same `matchDismissed` state in
// CallDetail.tsx), which meant dismissing an unrelated calendar-match
// suggestion silently suppressed the identity-detection banner/button for
// that call too (and vice versa), with no way to undo just one of them —
// Settings' "show dismissed suggestions again" reset also cleared both
// together. Same shape as calendarMatch.ts's own dismissal, deliberately
// duplicated rather than shared for the same reason two independent
// suggestion types shouldn't share one on/off bit.
const DISMISSED_KEY = 'contactIntelligence.dismissedIdentitySuggestions'

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function isIdentitySuggestionDismissed(callId: string): boolean {
  return readDismissed().includes(callId)
}

export function dismissIdentitySuggestion(callId: string): void {
  const current = readDismissed()
  if (current.includes(callId)) return
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...current, callId]))
  } catch {
    /* localStorage unavailable — the suggestion just reappears next visit */
  }
}
