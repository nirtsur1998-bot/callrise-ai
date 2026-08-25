// M29 A1.3 — Settings → Privacy → Diagnostics & telemetry.
//
// The brief's four invariants, as a screen: it is OPT-IN (the switch is off
// until the user turns it on), REVOCABLE here, the id is SHOWN (so "anonymous"
// is something the user can check, not take on trust), and everything that
// would leave is INSPECTABLE — the list below renders the real queued
// payloads, not a description of them.

import { useEffect, useState } from 'react'
import { Eye, HeartPulse, Send, Trash2 } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SectionHeading } from './SectionHeading'
import { SettingRow } from './SettingRow'
import type {
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySentRow,
  TelemetryState
} from '../../../../preload/index.d'

import { TELEMETRY_NEVER_SENDS, TELEMETRY_SENDS } from './telemetry-copy'

function EventRow({ event }: { event: TelemetryEvent }): React.JSX.Element {
  return (
    <li className="rounded-lg border border-line-soft bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-fg-2">
      <div className="mb-1 flex items-center justify-between gap-3 font-sans text-[12px]">
        <span className="font-medium text-fg-1">{event.name}</span>
        <span className="text-fg-3">{new Date(event.ts).toLocaleString()}</span>
      </div>
      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(event.props, null, 2)}</pre>
    </li>
  )
}

function SentRow({ row }: { row: TelemetrySentRow }): React.JSX.Element {
  // Everything the server received for this event — the envelope fields
  // repeated per row, exactly as posted.
  const { event_id: _id, ...rest } = row
  return (
    <li className="rounded-lg border border-line-soft bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-fg-2">
      <div className="mb-1 flex items-center justify-between gap-3 font-sans text-[12px]">
        <span className="font-medium text-fg-1">{row.name}</span>
        <span className="text-fg-3">{new Date(row.client_ts).toLocaleString()}</span>
      </div>
      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(rest, null, 2)}</pre>
    </li>
  )
}

/** Exported for the status-honesty test — this string is a factual claim about
 *  the user's own data, so it is pinned rather than eyeballed. */
export function flushSummary(r: TelemetryFlushResult): string {
  if (r.attempted && r.sent > 0) return `Sent ${r.sent} event${r.sent === 1 ? '' : 's'}.`
  // A dropped batch is NOT "still queued". This branch has to come before the
  // generic one: the M29 sweep found the drop case falling through to
  // "Still queued; will retry later" — a status string that lied about the
  // user's own data at the one screen whose whole premise is that everything
  // here is inspectable rather than described.
  if (r.attempted && r.reason?.startsWith('dropped:')) {
    return `The server rejected these reports (${r.reason.replace('dropped: ', '')}), so they were discarded to keep newer ones flowing. They were not kept and will not be retried.`
  }
  if (r.attempted)
    return `Could not send (${r.reason ?? 'unknown'}). Still queued; will retry later.`
  switch (r.reason) {
    case 'nothing queued':
      return 'Nothing to send.'
    case 'consent off':
      return 'Diagnostics are off — nothing is sent.'
    case 'backing off':
      return 'A recent send failed; waiting before trying again.'
    case 'ingest not configured':
      return 'No destination is configured for this build.'
    default:
      return r.reason ?? 'Nothing happened.'
  }
}

export function TelemetrySection(): React.JSX.Element {
  const [state, setState] = useState<TelemetryState | null>(null)
  const [busy, setBusy] = useState(false)
  const [showQueue, setShowQueue] = useState(false)
  const [showSent, setShowSent] = useState(false)
  const [lastSend, setLastSend] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.telemetry
      .getState()
      .then((s) => {
        if (!cancelled) setState(s)
      })
      .catch(() => {
        /* leave the screen in its loading state rather than show a wrong one */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setConsent = async (on: boolean): Promise<void> => {
    setBusy(true)
    try {
      setState(await window.api.telemetry.setConsent(on ? 'on' : 'off'))
    } finally {
      setBusy(false)
    }
  }

  const clearQueue = async (): Promise<void> => {
    setBusy(true)
    try {
      setState(await window.api.telemetry.clearQueue())
    } finally {
      setBusy(false)
    }
  }

  const clearSent = async (): Promise<void> => {
    setBusy(true)
    try {
      setState(await window.api.telemetry.clearSent())
    } finally {
      setBusy(false)
    }
  }

  const sendNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const { result, state: next } = await window.api.telemetry.flushNow()
      setState(next)
      setLastSend(flushSummary(result))
    } finally {
      setBusy(false)
    }
  }

  const on = state?.consent.consent === 'on'
  const queued = state?.queued ?? []
  const sent = state?.sent ?? []

  return (
    <>
      <SectionHeading
        icon={HeartPulse}
        title="Diagnostics & telemetry"
        description="Off unless you turn it on. Helps us find crashes and broken features across versions — never your calls, notes, or keys."
      />

      <Card className="mb-5">
        <SettingRow
          title="Send anonymous diagnostics"
          description={
            on
              ? 'On. Crash and health reports go out in small batches. Turn off anytime — the queue and your install ID are deleted immediately.'
              : 'Off. Nothing is collected or sent. CallRise works exactly the same either way.'
          }
          control={
            <ToggleSwitch
              checked={on}
              disabled={busy || state === null}
              onChange={(v) => void setConsent(v)}
              label="Send anonymous diagnostics"
            />
          }
        />
        <div className="mt-4 grid gap-4 border-t border-line-soft pt-4 text-[12.5px] leading-relaxed md:grid-cols-2">
          <div>
            <p className="mb-1.5 font-medium text-fg-1">What it sends</p>
            <ul className="list-disc space-y-1 pl-4 text-fg-2">
              {TELEMETRY_SENDS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1.5 font-medium text-fg-1">What it never sends</p>
            <ul className="list-disc space-y-1 pl-4 text-fg-2">
              {TELEMETRY_NEVER_SENDS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      <Card className="mb-5">
        <SettingRow
          title="Your install ID"
          description={
            state?.anonId
              ? 'A random number made on this computer when you turned diagnostics on. It is not your account, your email, or anything about you, and it is deleted when you turn diagnostics off.'
              : 'None — an ID is only created when you turn diagnostics on.'
          }
          control={
            <code className="rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-fg-2">
              {state?.anonId ?? '—'}
            </code>
          }
        />
      </Card>

      <Card className="mb-5">
        <SettingRow
          title="View what's queued to be sent"
          description={
            queued.length === 0
              ? 'Nothing is waiting. This list shows the exact payloads, not a summary of them.'
              : `${queued.length} event${queued.length === 1 ? '' : 's'} waiting. These are the exact payloads that will leave this computer on the next send.`
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={Eye}
                onClick={() => setShowQueue((v) => !v)}
                disabled={queued.length === 0}
              >
                {showQueue ? 'Hide' : 'Show'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={Send}
                onClick={() => void sendNow()}
                disabled={busy || !on || queued.length === 0}
              >
                Send now
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={Trash2}
                onClick={() => void clearQueue()}
                disabled={busy || queued.length === 0}
              >
                Delete queue
              </Button>
            </div>
          }
        />
        {lastSend && <p className="mt-3 text-[12px] text-fg-3">{lastSend}</p>}
        {showQueue && queued.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-line-soft pt-4">
            {queued.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SettingRow
          title="View what's been sent"
          description={
            sent.length === 0
              ? 'Nothing has been sent from this computer.'
              : `The last ${sent.length} event${sent.length === 1 ? '' : 's'} that left this computer, exactly as they were sent — including the install ID and session ID that went with them.`
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={Eye}
                onClick={() => setShowSent((v) => !v)}
                disabled={sent.length === 0}
              >
                {showSent ? 'Hide' : 'Show'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={Trash2}
                onClick={() => void clearSent()}
                disabled={busy || sent.length === 0}
              >
                Delete this record
              </Button>
            </div>
          }
        />
        {showSent && sent.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-line-soft pt-4">
            {sent.map((r) => (
              <SentRow key={r.event_id} row={r} />
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
