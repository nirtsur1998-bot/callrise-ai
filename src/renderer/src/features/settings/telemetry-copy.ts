// M29 A1.3 — the honest list, shared by the Settings page and the one-time
// Home card so the user never consents to one description and later reads
// another. Keep it literal; it is the thing the switch is consenting to.

export const TELEMETRY_SENDS: ReadonlyArray<string> = [
  'Which version of CallRise crashed or hit an error, and where in the code (the error type and a scrubbed stack trace — no messages).',
  'Counts: how often a feature was opened, how often an AI job failed and why (rate limit, bad key, timeout), whether an update installed.',
  'Your operating system version, and a random ID for this install so repeat crashes can be told apart from many different ones.'
]

export const TELEMETRY_NEVER_SENDS: ReadonlyArray<string> = [
  'Transcripts, recordings, summaries, memories, notes, contacts, deals, or anything said on a call.',
  'Your API keys, your email, your name, your account, or files on your computer.',
  'The contents of error messages — only their type and location.'
]
