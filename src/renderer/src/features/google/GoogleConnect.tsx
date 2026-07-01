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
      return 'You declined the Google permission. Click Connect to try again.'
    case 'timeout':
      return 'Authorization timed out — click Connect to try again.'
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
  const [testMsg, setTestMsg] = useState<string | null>(null) // TEMP (Step A)
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
    setTestMsg(null)
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

  // TEMP (Step A): proves the write scope actually works end-to-end.
  const createTestEvent = async (): Promise<void> => {
    setTestMsg(null)
    setError(null)
    const res = await window.api.google.createTestEvent()
    if (!mounted.current) return
    if (res.ok) setTestMsg('Test event created in your Google Calendar (safe to delete).')
    else setError(friendlyError(res.error))
  }

  const disconnect = async (): Promise<void> => {
    await window.api.google.disconnect()
    if (!mounted.current) return
    setConnected(false)
    setMode('readonly')
    setCalendars([])
    setError(null)
    setTestMsg(null)
    onChange?.() // clear the Google events from the calendar
  }

  if (loading) return null // nothing flickers before we know the status

  if (!configured) {
    return (
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-[13px] text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Add <code className="text-amber-200">GOOGLE_CLIENT_ID</code> and{' '}
          <code className="text-amber-200">GOOGLE_CLIENT_SECRET</code> to your <code>.env</code>,
          then restart, to connect Google Calendar.
        </span>
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-xl border border-line-soft bg-surface px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px]">
          {connected ? (
            <>
              <CalendarCheck2 className="h-4 w-4 text-emerald-300" />
              <span className="font-medium text-emerald-300">Connected to Google Calendar</span>
              <span className="text-faint">
                · {mode === 'readwrite' ? 'two-way sync on' : 'read-only'}
              </span>
              {syncing ? (
                <span className="text-faint">· syncing…</span>
              ) : lastSynced ? (
                <span className="text-faint">· updated {agoLabel(lastSynced)}</span>
              ) : null}
            </>
          ) : (
            <>
              <CalendarCheck2 className="h-4 w-4 text-faint" />
              <span className="text-muted">Google Calendar — not connected</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {connected ? (
            <>
              {mode === 'readonly' ? (
                <button
                  type="button"
                  onClick={() => void enableTwoWaySync()}
                  disabled={enablingSync}
                  title="Let Sales OS add and update events in your Google Calendar"
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition',
                    enablingSync
                      ? 'cursor-default bg-elevated text-muted'
                      : 'bg-accent text-white hover:brightness-110'
                  )}
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
                </button>
              ) : (
                // TEMP (Step A): proof the write scope works. Replaced in Step B.
                <button
                  type="button"
                  onClick={() => void createTestEvent()}
                  title="Create a throwaway event in your Google Calendar to verify writing works"
                  className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
                >
                  Create test event
                </button>
              )}
              <button
                type="button"
                disabled={syncing}
                onClick={() => {
                  void loadCalendars()
                  onChange?.() // re-pull events too
                }}
                title="Re-read your calendars and events"
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} /> Refresh
              </button>
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={connecting}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                connecting
                  ? 'cursor-default bg-elevated text-muted'
                  : 'bg-accent text-white hover:brightness-110'
              )}
            >
              {connecting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for Google…
                </>
              ) : (
                <>
                  <Plug className="h-3.5 w-3.5" /> Connect Google Calendar
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {(connecting || enablingSync) && (
        <p className="mt-2 text-[11px] text-faint">
          A Google sign-in opened in your browser. Approve it there (click past the “unverified app”
          warning){enablingSync && ' and allow the “see and edit events” permission'}, then come
          back — this updates automatically.
        </p>
      )}

      {/* TEMP (Step A): confirmation that a write reached Google. */}
      {testMsg && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-300">
          <Check className="h-3 w-3 shrink-0" /> {testMsg}
        </p>
      )}

      {/* Step-1 proof: the authenticated read worked and here are your calendars. */}
      {connected && calendars.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {calendars.map((c) => (
            <span
              key={c.id}
              className="flex items-center gap-1 rounded-md border border-line-soft bg-canvas px-2 py-1 text-[11px] text-muted"
            >
              <Check className="h-3 w-3 text-emerald-300" />
              {c.summary}
              {c.primary && <span className="text-faint">(primary)</span>}
            </span>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-rose-300">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {error}
        </p>
      )}
    </div>
  )
}
