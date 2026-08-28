// M29 A1.3 — the one-time ask. Shown on Home only while the device has never
// answered ('unasked'). Both buttons record a decision, so this appears
// exactly once per device; "Not now" is a real 'off', not a snooze. The
// honest copy is the same list Settings shows, so the user never consents
// to one description and later reads another.
//
// Why Home and not onboarding (yet): onboarding is rebuilt in Workstream
// B3; until then every existing install would otherwise never be asked.
// B3 adds the same question as a step and this card stays for upgrades.

import { useEffect, useState } from 'react'
import { HeartPulse } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import type { NavId } from '@renderer/features/navigation/nav-items'
import { TELEMETRY_NEVER_SENDS, TELEMETRY_SENDS } from '@renderer/features/settings/telemetry-copy'

export function TelemetryAskCard({
  onNavigate
}: {
  onNavigate: (id: NavId) => void
}): React.JSX.Element | null {
  const [unasked, setUnasked] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.telemetry
      .getState()
      .then((s) => {
        if (!cancelled) setUnasked(s.consent.consent === 'unasked')
      })
      .catch(() => {
        /* can't read it — ask nothing rather than ask wrongly */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const decide = async (value: 'on' | 'off'): Promise<void> => {
    setBusy(true)
    try {
      await window.api.telemetry.setConsent(value)
      setUnasked(false)
    } catch {
      setBusy(false)
    }
  }

  if (!unasked) return null

  return (
    <div className="mb-5 rounded-xl border border-line bg-surface-1 px-5 py-4 text-[13px] text-fg-2">
      <div className="flex items-start gap-3">
        <HeartPulse className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg-1">Help find crashes? (optional, anonymous)</p>
          <p className="mt-1 leading-relaxed">
            CallRise can send anonymous crash and health reports so broken versions get fixed
            faster. It is off until you say yes, and you can change your mind in Settings → Privacy
            → Diagnostics &amp; telemetry — where you can also read every payload before it goes.
          </p>
          <div className="mt-3 grid gap-3 text-[12px] leading-relaxed md:grid-cols-2">
            <div>
              <p className="mb-1 font-medium text-fg-1">Sends</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {TELEMETRY_SENDS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 font-medium text-fg-1">Never sends</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {TELEMETRY_NEVER_SENDS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide('on')}>
              Yes, send anonymous diagnostics
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void decide('off')}
            >
              No thanks
            </Button>
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="ml-1 text-[12px] font-medium text-fg-3 underline underline-offset-2 hover:text-fg-2 hover:no-underline"
            >
              Read more in Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
