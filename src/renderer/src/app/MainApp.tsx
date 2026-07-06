import { useEffect, useRef, useState } from 'react'
import AppShell from './AppShell'
import { Sidebar } from '@renderer/features/navigation/Sidebar'
import { CopilotPanel } from '@renderer/features/copilot/CopilotPanel'
import { HomeView } from '@renderer/features/home/HomeView'
import { LiveView } from '@renderer/features/live/LiveView'
import { PastCallsView } from '@renderer/features/calls/PastCallsView'
import { TasksView } from '@renderer/features/tasks/TasksView'
import { CrmView } from './CrmView'
import { CalendarView } from '@renderer/features/calendar/CalendarView'
import { CoachingView } from '@renderer/features/coaching/CoachingView'
import { AnalyticsView } from '@renderer/features/analytics/AnalyticsView'
import { SettingsShell } from '@renderer/features/settings/SettingsShell'
import { KnowledgeView } from '@renderer/features/knowledge/KnowledgeView'
import { PlaceholderView } from '@renderer/components/PlaceholderView'
import { NAV_ITEMS, type NavId } from '@renderer/features/navigation/nav-items'
import type { AuthUser } from '@renderer/features/auth/types'
import { getAutoOpenMeetingPage } from '@renderer/features/settings/prefs'

/** The signed-in application shell. Only rendered once a user is logged in. */
export function MainApp({ user }: { user: AuthUser }): React.JSX.Element {
  const [active, setActive] = useState<NavId>('home')
  const activeItem = NAV_ITEMS.find((item) => item.id === active) ?? NAV_ITEMS[0]

  // Remember the last non-settings tab, so Settings' Back arrow returns to
  // wherever the user actually was, not always Home.
  const lastNonSettingsRef = useRef<NavId>('home')
  useEffect(() => {
    if (active !== 'settings') lastNonSettingsRef.current = active
  }, [active])

  // AI Note Taker's "auto-open meeting page": which call to preselect when
  // Past Calls next renders. Cleared once consumed so a later manual visit
  // to Past Calls doesn't keep reopening a stale call.
  const [openCallId, setOpenCallId] = useState<string | null>(null)
  const handleCallSaved = (callId: string): void => {
    if (!getAutoOpenMeetingPage()) return
    setOpenCallId(callId)
    setActive('past-calls')
  }

  const signOut = (): void => {
    void window.api.auth.signOut() // the gate swaps back to the login screen via the broadcast
  }

  // Settings is a dedicated full-screen surface (its own nav, no copilot),
  // not one more panel inside the normal 3-column shell.
  if (active === 'settings') {
    return <SettingsShell user={user} onBack={() => setActive(lastNonSettingsRef.current)} />
  }

  return (
    <AppShell
      title={activeItem.label}
      sidebar={<Sidebar active={active} onSelect={setActive} user={user} onSignOut={signOut} />}
      copilot={<CopilotPanel />}
    >
      {active === 'home' ? (
        <HomeView />
      ) : active === 'live-calls' ? (
        <LiveView onSaved={handleCallSaved} />
      ) : active === 'past-calls' ? (
        <PastCallsView
          initialSelectedId={openCallId}
          onInitialSelectionConsumed={() => setOpenCallId(null)}
        />
      ) : active === 'tasks' ? (
        <TasksView />
      ) : active === 'crm' ? (
        <CrmView />
      ) : active === 'calendar' ? (
        <CalendarView />
      ) : active === 'coaching' ? (
        <CoachingView />
      ) : active === 'analytics' ? (
        <AnalyticsView />
      ) : active === 'knowledge' ? (
        <KnowledgeView />
      ) : (
        <PlaceholderView title={activeItem.label} icon={activeItem.icon} />
      )}
    </AppShell>
  )
}
