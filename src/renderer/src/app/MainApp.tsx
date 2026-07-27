import { useEffect, useRef, useState } from 'react'
import AppShell from './AppShell'
import { Sidebar } from '@renderer/features/navigation/Sidebar'
import { CopilotPanel } from '@renderer/features/copilot/CopilotPanel'
import { useVoiceAiCollapsed } from '@renderer/features/copilot/useVoiceAiCollapsed'
import { CommandPalette, type PaletteAction } from '@renderer/features/navigation/CommandPalette'
import { ShortcutsOverlay } from '@renderer/features/navigation/ShortcutsOverlay'
import { PhoneCall, SunMoon } from 'lucide-react'
import { useTheme } from '@renderer/features/settings/useTheme'
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
import { TeamView } from '@renderer/features/team/TeamView'
import { PlaceholderView } from '@renderer/components/PlaceholderView'
import { NAV_ITEMS, type NavId } from '@renderer/features/navigation/nav-items'
import type { AuthUser } from '@renderer/features/auth/types'
import { getAutoOpenMeetingPage } from '@renderer/features/settings/prefs'
import { useAutoTranscribeCalls } from '@renderer/features/settings/useAutoTranscribeCalls'
import { CallDetectedBanner } from '@renderer/features/live/components/CallDetectedBanner'

/** The signed-in application shell. Only rendered once a user is logged in.
 *  `initialNav` lets onboarding drop the user straight onto a screen (e.g. Live
 *  Calls after "Start my first call") instead of always landing on Home. */
export function MainApp({
  user,
  initialNav = 'home'
}: {
  user: AuthUser
  initialNav?: NavId
}): React.JSX.Element {
  const [active, setActive] = useState<NavId>(initialNav)
  const [copilotCollapsed, setCopilotCollapsed] = useVoiceAiCollapsed()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const { mode: themeMode, setMode: setThemeMode } = useTheme()
  const activeItem = NAV_ITEMS.find((item) => item.id === active) ?? NAV_ITEMS[0]

  // "We noticed a call" — a known-calling-app (WhatsApp, Zoom, Teams, …)
  // became frontmost while the rep was away. With auto-transcribe off, this
  // shows a top banner the rep must explicitly accept; with it on, we skip
  // the prompt and jump straight into Live Calls with a one-shot auto-start.
  const [autoTranscribeCalls] = useAutoTranscribeCalls()
  const [detectedCallApp, setDetectedCallApp] = useState<string | null>(null)
  const [pendingCallAutoStart, setPendingCallAutoStart] = useState(false)

  useEffect(() => {
    return window.api.app.onCallDetected((appName) => {
      if (autoTranscribeCalls) {
        setActive('live-calls')
        setPendingCallAutoStart(true)
      } else {
        setDetectedCallApp(appName)
      }
    })
  }, [autoTranscribeCalls])

  // Ambient call detection (M15) - feature-flagged off by default
  // (app-settings.ts's detection.enabled), so this never fires until that's
  // turned on. Reuses the exact same "jump to Live Calls + auto-start" path
  // as the app-name-only detection above, just from a different source and
  // with an ack back to main (which is waiting to know whether the renderer
  // actually managed to start recording).
  const [ambientAutoStart, setAmbientAutoStart] = useState<{
    callId: string
    mode: 'full' | 'mic-only'
  } | null>(null)

  useEffect(() => {
    return window.api.detection.onStartCapture(({ call, mode }) => {
      setActive('live-calls')
      setAmbientAutoStart({ callId: call.id, mode })
    })
  }, [])

  const handleAmbientAutoStartResult = (
    result: { callId: string } & ({ ok: true; sessionId: number } | { ok: false })
  ): void => {
    if (result.ok) {
      void window.api.detection.captureStarted({
        callId: result.callId,
        sessionId: String(result.sessionId)
      })
    } else {
      void window.api.detection.captureFailed({ callId: result.callId })
    }
  }

  // Overlay banner's Stop/Pause buttons act on a DIFFERENT window (the
  // always-on-top overlay) than the one actually holding the recording (this
  // main window's LiveView) - these requests get forwarded down as nonce
  // tokens so LiveView's effect can act on each one exactly once.
  const [remoteStopToken, setRemoteStopToken] = useState(0)
  const [remotePauseToken, setRemotePauseToken] = useState(0)
  useEffect(() => {
    const offStop = window.api.detection.onRequestStopCapture(() =>
      setRemoteStopToken((n) => n + 1)
    )
    const offPause = window.api.detection.onRequestTogglePause(() =>
      setRemotePauseToken((n) => n + 1)
    )
    return () => {
      offStop()
      offPause()
    }
  }, [])

  const startTranscribingDetectedCall = (): void => {
    setDetectedCallApp(null)
    setActive('live-calls')
    setPendingCallAutoStart(true)
  }

  // Quick actions offered by the command palette alongside screen jumps.
  // Kept small and honest — only things this component can actually do
  // without reaching into other features' local state.
  const paletteActions: PaletteAction[] = [
    {
      id: 'live-call',
      label: 'Start a live call',
      icon: PhoneCall,
      onRun: () => setActive('live-calls')
    },
    {
      id: 'toggle-theme',
      label: 'Toggle theme',
      icon: SunMoon,
      onRun: () => setThemeMode(themeMode === 'light' ? 'dark' : 'light')
    }
  ]

  // Global ⌘K / Ctrl+K toggles the command palette from anywhere (including
  // Settings, which renders its own shell below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Global `?` opens the keyboard-shortcuts cheat sheet, except while the
  // user is typing in a text field (so a literal "?" still types normally).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '?') return
      const el = document.activeElement
      const isTyping =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      if (isTyping) return
      e.preventDefault()
      setShortcutsOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

  const palette = (
    <>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={setActive}
        actions={paletteActions}
      />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {detectedCallApp && (
        <CallDetectedBanner
          appName={detectedCallApp}
          onStart={startTranscribingDetectedCall}
          onDismiss={() => setDetectedCallApp(null)}
        />
      )}
    </>
  )

  // Settings is a dedicated full-screen surface (its own nav, no copilot),
  // not one more panel inside the normal 3-column shell.
  if (active === 'settings') {
    return (
      <>
        <SettingsShell user={user} onBack={() => setActive(lastNonSettingsRef.current)} />
        {palette}
      </>
    )
  }

  return (
    <AppShell
      title={activeItem.label}
      sidebar={
        <Sidebar
          active={active}
          onSelect={setActive}
          user={user}
          onSignOut={signOut}
          onOpenPalette={() => setPaletteOpen(true)}
        />
      }
      copilot={
        <CopilotPanel
          collapsed={copilotCollapsed}
          onToggleCollapsed={() => setCopilotCollapsed(!copilotCollapsed)}
        />
      }
      copilotCollapsed={copilotCollapsed}
    >
      {/* Keyed on the active screen so each view fades/slides in on switch. */}
      <div key={active} className="animate-view">
        {active === 'home' ? (
          <HomeView
            userName={user.name?.trim() || user.email.split('@')[0]}
            onNavigate={setActive}
          />
        ) : active === 'live-calls' ? (
          <LiveView
            onSaved={handleCallSaved}
            autoStartFromDetection={pendingCallAutoStart}
            onAutoStartFromDetectionConsumed={() => setPendingCallAutoStart(false)}
            ambientAutoStart={ambientAutoStart}
            onAmbientAutoStartConsumed={() => setAmbientAutoStart(null)}
            onAmbientAutoStartResult={handleAmbientAutoStartResult}
            remoteStopToken={remoteStopToken}
            remotePauseToken={remotePauseToken}
          />
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
        ) : active === 'team' ? (
          <TeamView />
        ) : (
          <PlaceholderView title={activeItem.label} icon={activeItem.icon} onNavigate={setActive} />
        )}
      </div>
      {palette}
    </AppShell>
  )
}
