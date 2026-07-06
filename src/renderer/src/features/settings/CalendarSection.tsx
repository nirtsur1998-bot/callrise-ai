import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { GoogleConnect } from '@renderer/features/google/GoogleConnect'
import { useAppSettings } from './useAppSettings'

/** True if a device other than this one connected Google Calendar for this
 *  account (a non-secret flag synced via app settings — never the OAuth
 *  token itself, which stays local always). */
function useReconnectNudge(): boolean {
  const { settings } = useAppSettings()
  const [localConnected, setLocalConnected] = useState<boolean | null>(null)

  useEffect(() => {
    void window.api.google.getStatus().then((s) => setLocalConnected(s.connected))
  }, [])

  return localConnected === false && settings.googleCalendarConnected
}

export function CalendarSection(): React.JSX.Element {
  const showReconnectNudge = useReconnectNudge()

  return (
    <Card className="mb-5">
      <p className="mb-3 text-[13px] text-muted">
        Connect Google Calendar to pull your meetings into the in-app calendar, and optionally push
        app events back out (two-way sync).
      </p>
      {showReconnectNudge && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-[13px] text-ink">
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            Your account connected Google Calendar on another device. Click Connect below to relink
            it here — nothing about the connection itself syncs between devices, so this is a
            one-time step per device.
          </span>
        </div>
      )}
      <GoogleConnect />
    </Card>
  )
}
