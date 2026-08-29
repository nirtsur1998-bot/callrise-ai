import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Plug, RefreshCw, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { GoogleConnect } from '@renderer/features/google/GoogleConnect'
import { OutlookConnect } from '@renderer/features/outlook/OutlookConnect'
import { loadConnectBannerDismissed, saveConnectBannerDismissed } from './calendarPreview'

interface CalendarConnectBarProps {
  googleSyncing: boolean
  googleLastSynced: number | null
  outlookSyncing: boolean
  outlookLastSynced: number | null
  onRefreshGoogle: () => void
  onRefreshOutlook: () => void
}

function agoLabel(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

/** M31 calendar-research Slice A — replaces the two permanent full-width
 *  "Connect Google / Connect Outlook" cards that occupied the top of the
 *  calendar whether or not anything was connected (research doc §2.6: no
 *  researched calendar app keeps a permanent connect billboard; Notion
 *  Calendar treats connecting as one-time onboarding that then goes away).
 *
 *  Nothing is removed — the real GoogleConnect/OutlookConnect cards are one
 *  click away behind this bar's disclosure, which is also the "where it
 *  went" pointer the milestone's constraints require. Deliberately NOT a
 *  link to Settings -> Calendar: settings deep-links don't exist yet (Stage
 *  3), so sending users there would land them on Settings -> Account and
 *  strand the flow. */
export function CalendarConnectBar({
  googleSyncing,
  googleLastSynced,
  outlookSyncing,
  outlookLastSynced,
  onRefreshGoogle,
  onRefreshOutlook
}: CalendarConnectBarProps): React.JSX.Element | null {
  const [status, setStatus] = useState<{ google: boolean; outlook: boolean } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(loadConnectBannerDismissed)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const [g, o] = await Promise.all([
        window.api.google.getStatus(),
        window.api.outlook.getStatus()
      ])
      if (!mounted.current) return
      setStatus({ google: g.connected, outlook: o.connected })
    } catch {
      /* leave the last known status; the bar is not worth an error state */
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Nothing renders until the real status is known — a bar that flashes
  // "not connected" and then corrects itself is worse than a beat of nothing.
  if (!status) return null

  const anyConnected = status.google || status.outlook
  const syncing = googleSyncing || outlookSyncing
  const lastSynced =
    status.google && status.outlook
      ? Math.max(googleLastSynced ?? 0, outlookLastSynced ?? 0) || null
      : status.google
        ? googleLastSynced
        : outlookLastSynced

  const dismiss = (): void => {
    setDismissed(true)
    saveConnectBannerDismissed(true)
  }

  const refreshAll = (): void => {
    if (status.google) onRefreshGoogle()
    if (status.outlook) onRefreshOutlook()
  }

  const cards = expanded ? (
    <div className="mt-2 flex flex-wrap gap-3 [&>*]:!mb-0 [&>*]:min-w-[300px] [&>*]:flex-1">
      <GoogleConnect
        onChange={() => {
          void refreshStatus()
          onRefreshGoogle()
        }}
        syncing={googleSyncing}
        lastSynced={googleLastSynced}
      />
      <OutlookConnect
        onChange={() => {
          void refreshStatus()
          onRefreshOutlook()
        }}
        syncing={outlookSyncing}
        lastSynced={outlookLastSynced}
      />
    </div>
  ) : null

  if (anyConnected) {
    return (
      <div className="mb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted">
          {status.google && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-positive" />
              Google
            </span>
          )}
          {status.outlook && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-track-outlook" />
              Outlook
            </span>
          )}
          <span className="text-faint">
            {syncing ? 'Syncing…' : lastSynced ? `Updated ${agoLabel(lastSynced)}` : 'Connected'}
          </span>
          <button
            type="button"
            onClick={refreshAll}
            disabled={syncing}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-faint transition hover:bg-elevated hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', syncing && 'animate-spin')} /> Refresh
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-faint transition hover:bg-elevated hover:text-ink"
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
            {expanded ? 'Hide' : 'Manage'}
          </button>
        </div>
        {cards}
      </div>
    )
  }

  // Not connected. The prompt is dismissible, but "Connect" never leaves the
  // header — dismissing hides the explanation, never the entry point.
  if (dismissed) {
    return (
      <div className="mb-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-faint transition hover:bg-elevated hover:text-ink"
        >
          <Plug className="h-3 w-3" /> Connect a calendar
        </button>
        {cards}
      </div>
    )
  }

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-soft bg-surface px-3.5 py-2.5">
        <p className="min-w-0 flex-1 text-[12px] text-muted">
          Connect Google or Outlook to see your real meetings here. Events, tasks, and prep briefs
          work either way.
        </p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent-fill px-2.5 py-1 text-[12px] font-medium text-on-accent transition hover:brightness-110"
        >
          <Plug className="h-3 w-3" /> Connect
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          title="Dismiss — you can still connect from the header any time"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-elevated hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {cards}
    </div>
  )
}
