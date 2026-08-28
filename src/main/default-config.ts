// Safe-to-ship defaults for a packaged build, confirmed with the user before
// committing (2026-07-17). These are NOT secrets:
// - Supabase's anon key is designed to be public; real protection is the
//   database's row-level security, not hiding this key.
// - Google's installed-app OAuth client secret is explicitly documented by
//   Google as not confidential for desktop apps.
// A developer's own .env still takes priority (see index.ts) — these only
// fill in what's missing, so local dev against a different project/app
// still works unchanged.
export const DEFAULT_CONFIG = {
  // CUTOVER 2026-08-28 — moved to a NEW Supabase project. The old one
  // (fphvsuvpskqwkcpiocfz) stays untouched as a 30-day parachute; nothing
  // was migrated because the cloud is a MIRROR of local truth, not the
  // truth itself, and the real user count was 2 (one of them a test
  // account). Existing installs are signed out by this change and must
  // register again with the same email — see accountMigrationNoticePending
  // in app-settings.ts for the one-time card that says so.
  SUPABASE_URL: 'https://emsbcxwzbjttxpimvlnj.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtc2JjeHd6Ymp0dHhwaW12bG5qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4OTY4MDQsImV4cCI6MjEwMzQ3MjgwNH0.R-wDoubOCsSLsduH3SF3V97txWWCIQ_BCXA3ellBEJU',
  // Replaced 2026-08-05 — moved to a new Google Cloud project ('callrise-ai-504616')
  // under a different Google account, per explicit user request. The OAuth
  // consent screen for this new client starts in "Testing" status, which
  // restricts login to explicitly-added test users only — must be published
  // to "In production" before this works for any user besides those test
  // accounts (OAuth consent screen page → Publish app).
  GOOGLE_CLIENT_ID: '877875490182-d6gu698b28n8b5giod7q7kuo6vbh3p0t.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: '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',
  // Added 2026-08-06 — this was previously only ever set in one machine's
  // local .env override, so every OTHER install (including packaged builds
  // handed to testers) showed "Add OUTLOOK_CLIENT_ID to your .env" and could
  // never connect Outlook at all. Registered on portal.azure.com under
  // "Mobile and desktop applications" (a public client) — like Google's
  // installed-app client ID above, Microsoft's own docs treat this as not
  // confidential; the real protection is the redirect URI + PKCE, not
  // hiding this value. See outlook.ts for the OAuth flow itself.
  OUTLOOK_CLIENT_ID: 'd02b5c14-3fd5-4fec-aa85-5baaa2aa6a6a',
  // M23: the repo itself, not a secret — a plain public URL. updater/index.ts
  // parses this as a github.com repo URL and uses electron-updater's 'github'
  // provider, which reads the repo's Releases assets directly; no token
  // needed to CHECK for updates on a public repo (only to publish one).
  UPDATE_FEED_URL: 'https://github.com/nirtsur1998-bot/callrise-ai'
} as const
