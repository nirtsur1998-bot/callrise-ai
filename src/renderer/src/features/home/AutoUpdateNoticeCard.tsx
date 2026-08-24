// M29 (founder decision 2026-08-24) — the one-time honesty card for the
// auto-update default flipping to ON. Every pre-1.3.4 install had
// autoUpdateEnabled: false PERSISTED (whole-object settings writes), so the
// migration overrides that stored value — a change made FOR the user, which
// therefore must be shown TO the user, once, with the off-switch one click
// away. Fresh installs see it too: they weren't asked either.
//
// Dismissing clears autoUpdateNoticePending in real settings (not
// localStorage), so the card shows once per install, not once per window.

import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type { NavId } from '@renderer/features/navigation/nav-items'

export function AutoUpdateNoticeCard({
  onNavigate
}: {
  onNavigate: (id: NavId) => void
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings
      .get()
      .then((s) => {
        if (!cancelled) setPending(s.autoUpdateNoticePending === true)
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
    window.api.settings.update({ autoUpdateNoticePending: false }).catch(() => {
      /* worst case the card shows again next launch — better than a lost dismiss */
    })
  }

  if (!pending) return null

  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-line bg-surface-1 px-4 py-3 text-[13px] text-fg-2">
      <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg-1">CallRise now keeps itself up to date</p>
        <p className="mt-0.5 leading-relaxed">
          Updates download in the background and install when you quit the app — never during a
          call. This is on by default because updates are how privacy and security fixes reach you.
          The check sends no account information.{' '}
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Turn it off in Settings → App
          </button>
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 text-fg-3 transition hover:bg-surface-2 hover:text-fg-2"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
