// Cutover 2026-08-28 — the one-time card for moving to a new Supabase project.
//
// WHY THIS EXISTS AT ALL. The project switch invalidates every existing
// session, so the app asks for a sign-in that will not work with the old
// account. Without this card the experience reads as "my account and all my
// calls are gone" — the single most alarming thing this app could do, and it
// would be false. The change was made FOR the user, so it is shown TO them.
//
// WHAT IT MUST SAY, in this order: your data is safe and local; sign up again
// with the SAME email; do NOT press Sign out. That last one matters because
// Sign out is the one button that DOES destroy something — it clears the saved
// AI provider keys (auth.ts's signOut) — and a confused user hunting for a fix
// is exactly who would press it.
//
// Shown only to installs that predate the cutover. A fresh install never had an
// account on the old project, so telling it to "sign in again" would be a lie —
// see accountMigrationNoticePending's default of false in app-settings.ts.
//
// Dismissing clears the flag in REAL settings, so the card shows once per
// install rather than once per window.

import { useEffect, useState } from 'react'
import { KeyRound, X } from 'lucide-react'

export function AccountMigrationNoticeCard(): React.JSX.Element | null {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings
      .get()
      .then((s) => {
        if (!cancelled) setPending(s.accountMigrationNoticePending === true)
      })
      .catch(() => {
        /* can't read settings — show nothing rather than a wrong notice */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = (): void => {
    setPending(false) // hide immediately; the persist below is best-effort
    window.api.settings.update({ accountMigrationNoticePending: false }).catch(() => {
      /* worst case it shows again next launch — better than a lost dismiss */
    })
  }

  if (!pending) return null

  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-muted">
      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">You&rsquo;ll need to sign in again — your data is safe</p>
        <p className="mt-0.5 leading-relaxed">
          We moved to a new sign-in service, so your old session no longer works.{' '}
          <span className="font-medium text-ink">
            Create your account again using the same email address
          </span>{' '}
          and everything re-uploads itself. Your calls, transcripts, contacts and Sales Brain live on
          this computer and are completely unaffected.{' '}
          <span className="font-medium text-ink">
            Please don&rsquo;t press &ldquo;Sign out&rdquo;
          </span>{' '}
          — that clears your saved AI keys, and you don&rsquo;t need it here.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 text-faint transition hover:bg-elevated hover:text-muted"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
