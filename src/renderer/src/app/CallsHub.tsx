import { useEffect, useState } from 'react'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { LiveView } from '@renderer/features/live/LiveView'
import { PastCallsView } from '@renderer/features/calls/PastCallsView'

type CallsTab = 'live' | 'past'

const TABS: { id: CallsTab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'past', label: 'Past' }
]

interface CallsHubProps {
  onSaved: (callId: string) => void
  autoStartFromDetection: boolean
  onAutoStartFromDetectionConsumed: () => void
  ambientAutoStart: { callId: string; mode: 'full' | 'mic-only' } | null
  onAmbientAutoStartConsumed: () => void
  onAmbientAutoStartResult: (
    result: { callId: string } & ({ ok: true; sessionId: number } | { ok: false })
  ) => void
  remoteStopToken: number
  remotePauseToken: number
  initialCallId: string | null
  onInitialCallConsumed: () => void
}

/** M31 Stage 2 — Live Calls and Past Calls as tabs of one "Calls" screen,
 *  same reasoning as CrmView's Contacts/Deals/Follow-ups merge: they're one
 *  feature area (a call, live or already saved), not two. Neither LiveView
 *  nor PastCallsView changed; this only decides which is showing.
 *
 *  Deliberately a BARE tab strip, not a PageHeader — PastCallsView already
 *  renders its own "Past Calls" title internally, and LiveView's control bar
 *  serves as its header. A second title above either would duplicate one or
 *  add a redundant heading the other never had. Both screens already render
 *  inside AppShell's normal padded/scrolling content area today (LiveView
 *  is NOT fullBleed) — this hub adds nothing to that chain beyond the tab
 *  strip itself, so neither screen's layout assumptions change.
 *
 *  The existing cross-screen LiveCallPill already tells a user a call is
 *  live even while they're on the Past tab, so this hub doesn't need its
 *  own "pinned hero" mechanism to solve the same problem twice.
 *
 *  Tab is FORCED (not just defaulted) whenever a signal arrives that used
 *  to force-navigate the whole app to Live or Past before this hub existed
 *  — detection auto-start, or the palette/auto-open-meeting jump to a
 *  specific past call — so merging the screens doesn't silently change
 *  behavior a user already relies on. */
export function CallsHub({
  onSaved,
  autoStartFromDetection,
  onAutoStartFromDetectionConsumed,
  ambientAutoStart,
  onAmbientAutoStartConsumed,
  onAmbientAutoStartResult,
  remoteStopToken,
  remotePauseToken,
  initialCallId,
  onInitialCallConsumed
}: CallsHubProps): React.JSX.Element {
  const [tab, setTab] = useState<CallsTab>(initialCallId ? 'past' : 'live')

  useEffect(() => {
    if (autoStartFromDetection || ambientAutoStart) setTab('live')
  }, [autoStartFromDetection, ambientAutoStart])

  useEffect(() => {
    if (initialCallId) setTab('past')
  }, [initialCallId])

  return (
    <div>
      <SegmentedControl options={TABS} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'live' ? (
        <LiveView
          onSaved={onSaved}
          autoStartFromDetection={autoStartFromDetection}
          onAutoStartFromDetectionConsumed={onAutoStartFromDetectionConsumed}
          ambientAutoStart={ambientAutoStart}
          onAmbientAutoStartConsumed={onAmbientAutoStartConsumed}
          onAmbientAutoStartResult={onAmbientAutoStartResult}
          remoteStopToken={remoteStopToken}
          remotePauseToken={remotePauseToken}
        />
      ) : (
        <PastCallsView
          initialSelectedId={initialCallId}
          onInitialSelectionConsumed={onInitialCallConsumed}
        />
      )}
    </div>
  )
}
