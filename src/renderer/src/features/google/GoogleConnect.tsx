import { useEffect, useRef, useState } from 'react'
import {
  CalendarCheck2,
  Loader2,
  RefreshCw,
  Plug,
  Check,
  AlertTriangle,
  ArrowLeftRight
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Button } from '@renderer/components/Button'

type SyncMode = 'readonly' | 'readwrite'

interface Calendar {
  id: string
  summary: string
  primary: boolean
}

function friendlyError(code: string): string {
  switch (code) {
    case 'no-credentials':
      return 'Google credentials are missing from your .env.'
    case 'encryption-unavailable':
      return "This Mac's secure storage isn't available, so the login can't be saved safely."
    case 'access_denied':
      return "Google didn't grant access. If you declined, click Connect to try again — if your browser said “Access blocked”, see below."
    case 'timeout':
      // Google never redirected back. The most common reason by far is a
      // TERMINAL block in the browser that we can't see from here: Google's
      // "Access blocked — has not completed the Google verification process"
      // page, shown when this app's OAuth client is still in Testing status
      // and the chosen account isn't an approved tester. Retrying does
      // nothing for that, so the old "timed out — click Connect to try
      // again" was actively misleading: it framed a permanent
      // configuration problem as a transient one.
      return 'Google never finished authorizing. If your browser showed “Access blocked — CallRise AI has not completed the Google verification process”, retrying won’t help: this app’s Google connection is still in testing, and your account has to be added as an approved tester (or the app published) in its Google Cloud project first.'
    case 'read-failed':
      return "Couldn't read your calendars — try Refresh."
    case 'write-failed':
      return "Couldn't write to Google — try reconnecting two-way sync."
    default:
      return "Couldn't finish connecting to Google — click Connect to try again."
  }
}

/**
 * Connect Google Calendar (read-only): drives the OAuth IPC, shows status +
 * the calendar list, and calls `onChange` whenever the connection changes
 * (connect / disconnect / refresh) so the calendar can re-pull events.
 */
function agoLabel(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

export function GoogleConnect({
  onChange,
  syncing = false,
  lastSynced = null
}: {
  onChange?: () => void
  syncing?: boolean
  lastSynced?: number | null
}): React.JSX.Element | null {
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(true)
  const [connected, setConnected] = useState(false)
  const [mode, setMode] = useState<SyncMode>('readonly')
  const [connecting, setConnecting] = useState(false)
  const [enablingSync, setEnablingSync] = useState(false)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadCalendars = async (): Promise<void> => {
    const res = await window.api.google.listCalendars()
    if (!mounted.current) return
    if (res.ok) setCalendars(res.calendars)
    else if (res.error !== 'not-connected') setError(friendlyError(res.error))
  }

  const refreshStatus = async (): Promise<void> => {
    const status = await window.api.google.getStatus()
    if (!mounted.current) return
    setConfigured(status.configured)
    setConnected(status.connected)
    setMode(status.mode)
    if (status.connected) await loadCalendars()
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time status load on mount
    void refreshStatus().finally(() => {
      if (mounted.current) setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = async (): Promise<void> => {
    setError(null)
    setConnecting(true)
    try {
      const res = await window.api.google.connect()
      if (!mounted.current) return
      if (res.ok) {
        await refreshStatus()
        onChange?.() // let the calendar pull events now that we're connected
      } else setError(friendlyError(res.error))
    } finally {
      if (mounted.current) setConnecting(false)
    }
  }

  const enableTwoWaySync = async (): Promise<void> => {
    setError(null)
    setEnablingSync(true)
    try {
      const res = await window.api.google.connectWrite()
      if (!mounted.current) return
      if (res.ok) {
        await refreshStatus()
        onChange?.()
      } else setError(friendlyError(res.error))
    } finally {
      if (mounted.current) setEnablingSync(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    await window.api.google.disconnect()
    if (!mounted.current) return
    setConnected(false)
    setMode('readonly')
    setCalendars([])
    setError(null)
    onChange?.() // clear the Google events from the calendar
  }

  if (loading) return null // nothing flickers before we know the status

  if (!configured) {
    return (
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Add <code className="text-warning">GOOGLE_CLIENT_ID</code> and{' '}
          <code className="text-warning">GOOGLE_CLIENT_SECRET</code> to your <code>.env</code>, then
          restart, to connect Google Calendar.
        </span>
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5">
      {/* Icon chip + status text stacked, so the row never has to fight
          action buttons for horizontal space — the old layout put status and
          buttons on ONE row with justify-between, which looked fine at full
          width but wrapped mid-sentence the moment the card narrowed (e.g.
          the two-up Google+Outlook layout in CalendarView, ~300px each). */}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            connected ? 'bg-positive/15' : 'bg-elevated'
          )}
        >
          <CalendarCheck2 className={cn('h-4.5 w-4.5', connected ? 'text-positive' : 'text-faint')} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className={cn('text-sm font-medium', connected ? 'text-positive' : 'text-ink')}>
            {connected ? 'Connected to Google Calendar' : 'Google Calendar'}
          </p>
          <p className="mt-0.5 text-[12px] text-faint">
            {connected ? (
              <>
                {mode === 'readwrite' ? 'Two-way sync on' : 'Read-only'}
                {syncing ? ' · Syncing…' : lastSynced ? ` · Updated ${agoLabel(lastSynced)}` : ''}
              </>
            ) : (
              'Not connected'
            )}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {connected ? (
          <>
            {mode === 'readonly' && (
              <Button
                size="sm"
                onClick={() => void enableTwoWaySync()}
                disabled={enablingSync}
                title="Let CallRise AI add and update events in your Google Calendar"
              >
                {enablingSync ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for Google…
                  </>
                ) : (
                  <>
                    <ArrowLeftRight className="h-3.5 w-3.5" /> Enable two-way sync
                  </>
                )}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={syncing}
              onClick={() => {
                void loadCalendars()
                onChange?.() // re-pull events too
              }}
              title="Re-read your calendars and events"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} /> Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => void connect()} disabled={connecting}>
            {connecting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for Google…
              </>
            ) : (
              <>
                <Plug className="h-3.5 w-3.5" /> Connect Google Calendar
              </>
            )}
          </Button>
        )}
      </div>

      {/* The old wording told users to "click past the unverified app
          warning" as though every Google warning is dismissible. The one
          they actually hit most is not: "Access blocked — has not completed
          the Google verification process" is a dead end, and telling someone
          to click past it sends them looking for a button that isn't there.
          Both cases are now named for what they are. */}
      {(connecting || enablingSync) && (
        <p className="mt-2.5 text-[11px] text-faint">
          A Google sign-in opened in your browser. Approve it there
          {enablingSync && ' and allow the “see and edit events” permission'} — an “unverified app”
          warning can be clicked past. If it instead says “Access blocked”, stop: that one can’t be,
          and this account needs adding as an approved tester first.
        </p>
      )}

      {/* Step-1 proof: the authenticated read worked and here are your calendars. */}
      {connected && calendars.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {calendars.map((c) => (
            <span
              key={c.id}
              className="flex items-center gap-1 rounded-md border border-line-soft bg-canvas px-2 py-1 text-[11px] text-muted"
            >
              <Check className="h-3 w-3 text-positive" />
              {c.summary}
              {c.primary && <span className="text-faint">(primary)</span>}
            </span>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-danger">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {error}
        </p>
      )}
    </div>
  )
}
