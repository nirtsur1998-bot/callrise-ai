import { useState } from 'react'
import AppShell from './AppShell'
import { Sidebar } from '@renderer/features/navigation/Sidebar'
import { CopilotPanel } from '@renderer/features/copilot/CopilotPanel'
import { HomeView } from '@renderer/features/home/HomeView'
import { LiveView } from '@renderer/features/live/LiveView'
import { PastCallsView } from '@renderer/features/calls/PastCallsView'
import { TasksView } from '@renderer/features/tasks/TasksView'
import { CalendarView } from '@renderer/features/calendar/CalendarView'
import { CoachingView } from '@renderer/features/coaching/CoachingView'
import { AnalyticsView } from '@renderer/features/analytics/AnalyticsView'
import { SettingsView } from '@renderer/features/settings/SettingsView'
import { PlaceholderView } from '@renderer/components/PlaceholderView'
import { NAV_ITEMS, type NavId } from '@renderer/features/navigation/nav-items'
import type { AuthUser } from '@renderer/features/auth/types'

/** The signed-in application shell. Only rendered once a user is logged in. */
export function MainApp({ user }: { user: AuthUser }): React.JSX.Element {
  const [active, setActive] = useState<NavId>('home')
  const activeItem = NAV_ITEMS.find((item) => item.id === active) ?? NAV_ITEMS[0]

  const signOut = (): void => {
    void window.api.auth.signOut() // the gate swaps back to the login screen via the broadcast
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
        <LiveView />
      ) : active === 'past-calls' ? (
        <PastCallsView />
      ) : active === 'tasks' ? (
        <TasksView />
      ) : active === 'calendar' ? (
        <CalendarView />
      ) : active === 'coaching' ? (
        <CoachingView />
      ) : active === 'analytics' ? (
        <AnalyticsView />
      ) : active === 'settings' ? (
        <SettingsView />
      ) : (
        <PlaceholderView title={activeItem.label} icon={activeItem.icon} />
      )}
    </AppShell>
  )
}
