import { useEffect, useState } from 'react'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { CrmView } from './CrmView'
import { TasksView } from '@renderer/features/tasks/TasksView'
import { CalendarView } from '@renderer/features/calendar/CalendarView'

type PipelineTab = 'crm' | 'tasks' | 'calendar'

const TABS: { id: PipelineTab; label: string }[] = [
  { id: 'crm', label: 'CRM' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'calendar', label: 'Calendar' }
]

interface PipelineHubProps {
  /** M31 — the tab a redirected navigation asked for (OLD_TO_HUB_TAB). */
  initialTab?: string | null
  onInitialTabConsumed?: () => void
  initialContactId: string | null
  initialDealId: string | null
  onInitialCrmSelectionConsumed: () => void
  deepLinkEventId: string | null
  onDeepLinkConsumed: () => void
  /** M31 Slice B — open the call recorded during a meeting (Calendar tab). */
  onOpenCall: (callId: string) => void
}

/** M31 Stage 2 — CRM, Tasks, and Calendar as tabs of one "Pipeline" screen.
 *  CRM keeps its OWN internal Contacts/Deals/Follow-ups tabs completely
 *  unchanged (a deliberate two-level nesting — Pipeline > CRM > Contacts —
 *  rather than flattening to 5 sibling tabs, so CrmView's existing,
 *  already-tested tab logic never needs touching).
 *
 *  CRM and Tasks render their OWN internal PageHeader ("CRM"/"Tasks");
 *  Calendar owns its own `h-full flex-col` layout. All three already render
 *  inside AppShell's normal padded/scrolling content area today (none of
 *  the three NavIds this hub replaces was ever fullBleed) — this hub adds
 *  nothing to that chain beyond the tab strip itself, so no screen's layout
 *  assumptions change.
 *
 *  Tab is forced (not just defaulted) by the same signals that used to
 *  force-navigate the whole app to CRM or Calendar before this hub existed
 *  — the palette's "jump to a contact/deal" and a callrise://meeting deep
 *  link — so the merge doesn't change behavior a user already relies on. */
export function PipelineHub({
  initialTab,
  onInitialTabConsumed,
  initialContactId,
  initialDealId,
  onInitialCrmSelectionConsumed,
  deepLinkEventId,
  onDeepLinkConsumed,
  onOpenCall
}: PipelineHubProps): React.JSX.Element {
  const [tab, setTab] = useState<PipelineTab>(
    deepLinkEventId ? 'calendar' : ((initialTab as PipelineTab) ?? 'crm')
  )
  // M31 — a navigation that asked for a specific screen this hub absorbed
  // (Home's "Tasks due" card, a recent-items click, a deep link) arrives
  // with the tab it wanted. Applied once and then released, so it can
  // never fight a tab the user picks afterwards.
  useEffect(() => {
    if (!initialTab) return
    if (TABS.some((t) => t.id === initialTab)) setTab(initialTab as PipelineTab)
    onInitialTabConsumed?.()
  }, [initialTab])

  useEffect(() => {
    if (initialContactId || initialDealId) setTab('crm')
  }, [initialContactId, initialDealId])

  useEffect(() => {
    if (deepLinkEventId) setTab('calendar')
  }, [deepLinkEventId])

  return (
    <div>
      <SegmentedControl options={TABS} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'calendar' ? (
        <CalendarView
          deepLinkEventId={deepLinkEventId}
          onDeepLinkConsumed={onDeepLinkConsumed}
          onOpenCall={onOpenCall}
        />
      ) : tab === 'crm' ? (
        <CrmView
          initialContactId={initialContactId}
          initialDealId={initialDealId}
          onInitialSelectionConsumed={onInitialCrmSelectionConsumed}
        />
      ) : (
        <TasksView />
      )}
    </div>
  )
}
