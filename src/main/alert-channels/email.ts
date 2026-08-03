// Email channel adapter (M19 Task 1).
//
// Double opt-in: nothing dispatches to an email address until verified_at is
// set. Supabase's built-in SMTP setting only serves GoTrue auth emails (sign-
// up/password-reset) — there's no API to send arbitrary mail through it, so
// the actual sending happens from the alert-dispatcher edge function via
// Resend's HTTP API (no SDK needed — a single fetch call — so no new
// dependency in package.json). This file only builds the six-digit
// verification code; the edge function's `send-verification-email` path
// emails it.

import { randomInt } from 'node:crypto'

export const EMAIL_CODE_TTL_MS = 15 * 60_000 // 15 minutes

/** A 6-digit numeric code — matches the pattern already used for account
 *  email confirmation (auth.ts), so the UX is familiar. */
export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function isValidEmail(value: string): boolean {
  // Deliberately permissive — real validation is "did the verification email
  // arrive", not a regex. This only rejects obvious garbage before storing it.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}
