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
  SUPABASE_URL: 'https://fphvsuvpskqwkcpiocfz.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwaHZzdXZwc2txd2tjcGlvY2Z6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MTcyNDEsImV4cCI6MjA5ODM5MzI0MX0.FGtBQ3FmOd0JAS55ctb6eLNQ2GoN2haocaki7LkUm-E',
  // Replaced 2026-08-05 — moved to a new Google Cloud project ('callrise-ai-504616')
  // under a different Google account, per explicit user request. The OAuth
  // consent screen for this new client starts in "Testing" status, which
  // restricts login to explicitly-added test users only — must be published
  // to "In production" before this works for any user besides those test
  // accounts (OAuth consent screen page → Publish app).
  GOOGLE_CLIENT_ID: '877875490182-d6gu698b28n8b5giod7q7kuo6vbh3p0t.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: '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',
  // M23: the repo itself, not a secret — a plain public URL. updater/index.ts
  // parses this as a github.com repo URL and uses electron-updater's 'github'
  // provider, which reads the repo's Releases assets directly; no token
  // needed to CHECK for updates on a public repo (only to publish one).
  UPDATE_FEED_URL: 'https://github.com/nirtsur1998-bot/callrise-ai'
} as const
