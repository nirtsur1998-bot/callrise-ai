import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { GoogleConnect } from '@renderer/features/google/GoogleConnect'
import { OutlookConnect } from '@renderer/features/outlook/OutlookConnect'
import { useAppSettings } from './useAppSettings'

/** True if a device other than this one connected the given provider's
 *  calendar for this account (a non-secret flag synced via app settings —
 *  never the OAuth token itself, which stays local always). */
function useReconnectNudge(provider: 'google' | 'outlook', connectedOnAnyDevice: boolean): boolean {
  const [localConnected, setLocalConnected] = useState<boolean | null>(null)

  useEffect(() => {
    void window.api[provider].getStatus().then((s) => setLocalConnected(s.connected))
  }, [provider])

  return localConnected === false && connectedOnAnyDevice
}

function ReconnectNudge({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-[13px] text-ink">
      <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
      <span>
        Your account connected {label} on another device. Click Connect below to relink it here —
        nothing about the connection itself syncs between devices, so this is a one-time step per
        device.
      </span>
    </div>
  )
}

export function CalendarSection(): React.JSX.Element {
  const { settings } = useAppSettings()
  const showGoogleNudge = useReconnectNudge('google', settings.googleCalendarConnected)
  const showOutlookNudge = useReconnectNudge('outlook', settings.outlookCalendarConnected)

  return (
    <>
      <Card className="mb-5">
        <p className="mb-3 text-[13px] text-muted">
          Connect Google Calendar to pull your meetings into the in-app calendar, and optionally
          push app events back out (two-way sync).
        </p>
        {showGoogleNudge && <ReconnectNudge label="Google Calendar" />}
        <GoogleConnect />
      </Card>

      <Card className="mb-5">
        <p className="mb-3 text-[13px] text-muted">
          Connect Outlook / Microsoft 365 Calendar to pull your meetings into the in-app calendar,
          and optionally push app events back out (two-way sync). Only one of Google or Outlook
          should be in two-way sync at a time.
        </p>
        {showOutlookNudge && <ReconnectNudge label="Outlook Calendar" />}
        <OutlookConnect />
      </Card>
    </>
  )
}
