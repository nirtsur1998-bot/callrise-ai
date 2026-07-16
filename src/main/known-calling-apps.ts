// A curated, best-effort list of app names that indicate a voice/video call
// is likely happening — matched case-insensitively against active-win's
// `owner.name` (see active-app.ts). This is inherently a heuristic: it can't
// tell a call from someone just having the app open, and it can't see calls
// made inside a browser tab (Google Meet, browser-based WhatsApp, etc.) since
// active-win only reports the browser itself. Cross-platform (macOS/Windows).
export const KNOWN_CALLING_APPS = [
  'WhatsApp',
  'Zoom',
  'Microsoft Teams',
  'Teams',
  'Slack',
  'FaceTime',
  'Skype',
  'Discord',
  'Google Meet',
  'Webex',
  'Cisco Webex',
  'GoToMeeting',
  'RingCentral',
  'Dialpad',
  'Signal',
  'Telegram',
  'Viber',
  'Google Voice',
  'Cisco Jabber',
  'MicroSIP',
  'Zoiper',
  'X-Lite',
  'Bria',
  'CounterPath Bria',
  '3CX',
  'Vonage Business',
  'Ooma Office',
  'SquareTalk',
  'Square Talk'
]

/** Case-insensitive match against the known-calling-apps list. */
export function isKnownCallingApp(appName: string): boolean {
  const lower = appName.toLowerCase()
  return KNOWN_CALLING_APPS.some((known) => known.toLowerCase() === lower)
}
