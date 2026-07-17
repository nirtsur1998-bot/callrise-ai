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
  GOOGLE_CLIENT_ID: '601852733978-3u90vbgqnlcoigqd5g5mm6v8nr81sava.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: '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'
} as const
