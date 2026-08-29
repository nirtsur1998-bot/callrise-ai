import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import AppShell from './AppShell'
import { Sidebar } from '@renderer/features/navigation/Sidebar'
import { CopilotPanel } from '@renderer/features/copilot/CopilotPanel'
import { useVoiceAiCollapsed } from '@renderer/features/copilot/useVoiceAiCollapsed'
import { CommandPalette, type PaletteAction } from '@renderer/features/navigation/CommandPalette'
import { ShortcutsOverlay } from '@renderer/features/navigation/ShortcutsOverlay'
import { PhoneCall, SunMoon } from 'lucide-react'
import { useTheme } from '@renderer/features/settings/useTheme'
import { isMac } from '@renderer/lib/platform'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { PlaceholderView } from '@renderer/components/PlaceholderView'
import {
  NAV_ITEMS,
  NAV_ITEMS_PREVIEW,
  OLD_TO_HUB,
  remapForPreview,
  type NavId
} from '@renderer/features/navigation/nav-items'
import { useNavigationPreview } from '@renderer/features/navigation/useNavigationPreview'
import type { AuthUser } from '@renderer/features/auth/types'
import { getAutoOpenMeetingPage } from '@renderer/features/settings/prefs'
import { useAutoTranscribeCalls } from '@renderer/features/settings/useAutoTranscribeCalls'
import { CallDetectedBanner } from '@renderer/features/live/components/CallDetectedBanner'
import { MemoryReviewModal } from '@renderer/features/settings/MemoryReviewModal'
import { setGoToLiveCallsListener } from '@renderer/features/live/liveCallNav'
import {
  setOpenAssistantListener,
  type AssistantScopeRequest
} from '@renderer/features/assistant/assistantNav'

// Exactly one of these renders at a time (see the `active === ...` switch
// below, itself remounted via `key={active}` on every switch) — so eagerly
// importing all eleven, as this file used to, put every screen's code in
// every window's bundle whether or not that window would ever show it. The
// detection-overlay window is the extreme case: a second BrowserWindow that
// loads this SAME bundle (see main.tsx) to render one small floating card,
// yet paid to parse the entire CRM/Calendar/Coaching/Analytics/Settings/
// Knowledge/Team code along with everything else.
const HomeView = lazy(() =>
  import('@renderer/features/home/HomeView').then((m) => ({ default: m.HomeView }))
)
const LiveView = lazy(() =>
  import('@renderer/features/live/LiveView').then((m) => ({ default: m.LiveView }))
)
const PastCallsView = lazy(() =>
  import('@renderer/features/calls/PastCallsView').then((m) => ({ default: m.PastCallsView }))
)
const TasksView = lazy(() =>
  import('@renderer/features/tasks/TasksView').then((m) => ({ default: m.TasksView }))
)
const CrmView = lazy(() => import('./CrmView').then((m) => ({ default: m.CrmView })))
const AssistantView = lazy(() =>
  import('../features/assistant/AssistantView').then((m) => ({ default: m.AssistantView }))
)
const CalendarView = lazy(() =>
  import('@renderer/features/calendar/CalendarView').then((m) => ({ default: m.CalendarView }))
)
const CoachingView = lazy(() =>
  import('@renderer/features/coaching/CoachingView').then((m) => ({ default: m.CoachingView }))
)
const AnalyticsView = lazy(() =>
  import('@renderer/features/analytics/AnalyticsView').then((m) => ({ default: m.AnalyticsView }))
)
const SettingsShell = lazy(() =>
  import('@renderer/features/settings/SettingsShell').then((m) => ({ default: m.SettingsShell }))
)
const KnowledgeView = lazy(() =>
  import('@renderer/features/knowledge/KnowledgeView').then((m) => ({ default: m.KnowledgeView }))
)
const TeamView = lazy(() =>
  import('@renderer/features/team/TeamView').then((m) => ({ default: m.TeamView }))
)
// M31 Stage 2 — the three merged "hub" screens behind the navigationPreview
// flag. Each is a thin SegmentedControl wrapper; none of the screens above
// changed to support this, so these hubs simply lazy-import the same
// components a second time (harmless — Vite/webpack dedupes the chunk).
const CallsHub = lazy(() => import('./CallsHub').then((m) => ({ default: m.CallsHub })))
const PipelineHub = lazy(() => import('./PipelineHub').then((m) => ({ default: m.PipelineHub })))
const CoachingHub = lazy(() => import('./CoachingHub').then((m) => ({ default: m.CoachingHub })))
const LibraryHub = lazy(() => import('./LibraryHub').then((m) => ({ default: m.LibraryHub })))

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

  // M31 Stage 2 — behind a preview flag (Settings -> Appearance), default
  // off: today's 12-item nav is untouched either way. NAV_ITEMS/NAV_ITEMS_
  // PREVIEW share the exact same NavId type and Sidebar/CommandPalette
  // rendering code, so flipping this off is a complete, instant revert.
  const { enabled: navPreviewEnabled } = useNavigationPreview()
  const navItems = navPreviewEnabled ? NAV_ITEMS_PREVIEW : NAV_ITEMS
  const activeItem = navItems.find((item) => item.id === active) ?? navItems[0]

  // Every OLD screen id still resolves to a real, unwrapped screen (no case
  // below is ever removed) — OLD_TO_HUB only matters for choosing what the
  // SIDEBAR highlights and what the user lands on when preview mode merges
  // that old screen into a hub. Without it, an internal jump (e.g. ambient
  // detection firing setActive('live-calls')) would land on the bare old
  // screen while the 7-item sidebar has no matching highlighted item, and
  // the tab strip inside Calls/Pipeline/Library wouldn't reflect where the
  // user actually landed. Every internal navigation in this file goes
  // through `navigateTo`, never `setActive` directly, so this is the one
  // place that needs to know the mapping.
  const navigateTo = (id: NavId): void => {
    setActive(navPreviewEnabled ? (OLD_TO_HUB[id] ?? id) : id)
  }

  // M29 A3 — one coarse usage counter per section OPEN, from the single
  // place every navigation path (sidebar, palette, deep link) converges.
  // Consent-gated and allowlisted in main; a failure is nobody's problem.
  useEffect(() => {
    window.api.telemetry.featureOpened(active).catch(() => {})
  }, [active])

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
        navigateTo('live-calls')
        setPendingCallAutoStart(true)
      } else {
        setDetectedCallApp(appName)
      }
    })
  }, [autoTranscribeCalls])

  // M26 Phase 4.6 — the live-call pill (App.tsx) lives outside this
  // component's tree (same reason as ActivityCenter/InterruptedCallPrompt:
  // it must survive the swap to Settings' wholly separate tree) and has no
  // other way to bring MainApp back to Live Calls on click. Same
  // subscribe-in-an-effect shape as onCallDetected just above, minus the IPC
  // hop — both ends already live in this renderer process.
  useEffect(() => {
    setGoToLiveCallsListener(() => navigateTo('live-calls'))
    return () => setGoToLiveCallsListener(null)
  }, [])

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
      navigateTo('live-calls')
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
    navigateTo('live-calls')
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
      shortcut: isMac ? '⌘⇧L' : 'Ctrl ⇧L',
      onRun: () => navigateTo('live-calls')
    },
    {
      id: 'toggle-theme',
      label: 'Toggle theme',
      icon: SunMoon,
      shortcut: isMac ? '⌘⇧T' : 'Ctrl ⇧T',
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

  // M31 Stage 2 — the shortcuts the command palette now advertises as hints
  // must actually work, not just look like they do. ⌘⇧L/⌘⇧T mirror the two
  // palette quick actions; ⌘1-7 jump straight to a nav item BY POSITION,
  // active only with the preview nav on (a digit-per-row scheme stops being
  // a clean mnemonic once there are more than ~9 items, so the legacy
  // 12-item nav intentionally doesn't get one — see CommandPalette's
  // showNumberShortcuts doc comment).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        navigateTo('live-calls')
        return
      }
      if (e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        setThemeMode(themeMode === 'light' ? 'dark' : 'light')
        return
      }
      if (navPreviewEnabled && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const item = navItems[Number(e.key) - 1]
        if (item) {
          e.preventDefault()
          navigateTo(item.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navPreviewEnabled, navItems, themeMode])

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

  // The nav-preview toggle lives on the Appearance settings page, so it can
  // only ever flip while `active === 'settings'` — meaning `active` itself
  // never needs correcting at flip time, but the id Back will restore
  // (lastNonSettingsRef, captured before Settings was opened) can go stale
  // the instant the flag changes: a hub id ('calls'/'pipeline'/'library')
  // once the just-reverted 12-item sidebar has no entry for it, or a legacy
  // id ('live-calls', 'crm', 'knowledge', ...) once the 7-item sidebar
  // doesn't. Left uncorrected, Back lands on an orphaned screen the sidebar
  // has nothing highlighted for. Remapping the ref here — invisibly, while
  // Settings still fully occludes the content pane — means Back always
  // lands somewhere the CURRENT sidebar actually shows.
  useEffect(() => {
    lastNonSettingsRef.current = remapForPreview(lastNonSettingsRef.current, navPreviewEnabled)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navPreviewEnabled])

  // AI Note Taker's "auto-open meeting page": which call to preselect when
  // Past Calls next renders. Cleared once consumed so a later manual visit
  // to Past Calls doesn't keep reopening a stale call.
  const [openCallId, setOpenCallId] = useState<string | null>(null)
  const handleCallSaved = (callId: string): void => {
    if (!getAutoOpenMeetingPage()) return
    setOpenCallId(callId)
    navigateTo('past-calls')
  }

  // M19 Task 3B — a callrise://meeting/<eventId> deep link (from a
  // meeting_starting alert) jumps straight to Calendar and opens that
  // meeting's prep brief. Same one-shot preselect pattern as openCallId.
  const [deepLinkEventId, setDeepLinkEventId] = useState<string | null>(null)
  useEffect(() => {
    return window.api.prepBrief.onOpenRequested((eventId) => {
      setDeepLinkEventId(eventId)
      navigateTo('calendar')
    })
  }, [])

  // M25 Phase 5 — clicking the "Sales Brain learned N things" native
  // notification (memory-hooks.ts's notifyLearnedFromCall) opens a
  // standalone review modal, regardless of which page is currently active.
  const [reviewCallId, setReviewCallId] = useState<string | null>(null)
  useEffect(() => {
    return window.api.salesBrain.onReviewRequested((callId) => {
      setReviewCallId(callId)
    })
  }, [])

  // Command palette's "jump to a specific record" search results — same
  // one-shot preselect pattern as openCallId above, just for the CRM tabs.
  const [openContactId, setOpenContactId] = useState<string | null>(null)
  const [openDealId, setOpenDealId] = useState<string | null>(null)
  const openContactFromPalette = (id: string): void => {
    setOpenContactId(id)
    navigateTo('crm')
  }
  const openDealFromPalette = (id: string): void => {
    setOpenDealId(id)
    navigateTo('crm')
  }
  const openCallFromPalette = (id: string): void => {
    setOpenCallId(id)
    navigateTo('past-calls')
  }

  // M28 Part 4 — "open Rise about this client" from a contact/deal/call page.
  // Same one-shot preselect pattern as openCallId; the signal arrives through
  // assistantNav.ts's single listener slot (the liveCallNav shape).
  const [assistantScope, setAssistantScope] = useState<AssistantScopeRequest | null>(null)
  useEffect(() => {
    setOpenAssistantListener((scope) => {
      setAssistantScope(scope)
      navigateTo('assistant')
    })
    return () => setOpenAssistantListener(null)
  }, [])

  const signOut = (): void => {
    void window.api.auth.signOut() // the gate swaps back to the login screen via the broadcast
  }

  const palette = (
    <>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={navigateTo}
        navItems={navItems}
        showNumberShortcuts={navPreviewEnabled}
        actions={paletteActions}
        onOpenContact={openContactFromPalette}
        onOpenDeal={openDealFromPalette}
        onOpenCall={openCallFromPalette}
      />
      <ShortcutsOverlay
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        navPreviewEnabled={navPreviewEnabled}
      />
      {detectedCallApp && (
        <CallDetectedBanner
          appName={detectedCallApp}
          onStart={startTranscribingDetectedCall}
          onDismiss={() => setDetectedCallApp(null)}
        />
      )}
      {reviewCallId && (
        <MemoryReviewModal callId={reviewCallId} onClose={() => setReviewCallId(null)} />
      )}
    </>
  )

  // Settings is a dedicated full-screen surface (its own nav, no copilot),
  // not one more panel inside the normal 3-column shell.
  if (active === 'settings') {
    return (
      <>
        <Suspense fallback={null}>
          <SettingsShell user={user} onBack={() => setActive(lastNonSettingsRef.current)} />
        </Suspense>
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
          onSelect={navigateTo}
          user={user}
          onSignOut={signOut}
          onOpenPalette={() => setPaletteOpen(true)}
          navItems={navItems}
        />
      }
      copilot={
        <CopilotPanel
          collapsed={copilotCollapsed}
          onToggleCollapsed={() => setCopilotCollapsed(!copilotCollapsed)}
        />
      }
      copilotCollapsed={copilotCollapsed}
      fullBleed={active === 'assistant'}
    >
      {/* Keyed on the active screen so each view fades/slides in on switch.
          The assistant screen additionally needs the wrapper to be a real
          flex link in the height chain — audit G traced the dead-void layout
          bug to exactly this div swallowing h-full. */}
      <div
        key={active}
        className={
          active === 'assistant' ? 'animate-view flex min-h-0 flex-1 flex-col' : 'animate-view'
        }
      >
        <Suspense
          fallback={
            <div className="mx-auto max-w-3xl px-2 py-4">
              <SkeletonRows />
            </div>
          }
        >
          {active === 'home' ? (
            <HomeView
              userName={user.name?.trim() || user.email.split('@')[0]}
              onNavigate={navigateTo}
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
          ) : active === 'assistant' ? (
            <AssistantView
              onOpenCall={openCallFromPalette}
              initialScope={assistantScope}
              onInitialScopeConsumed={() => setAssistantScope(null)}
            />
          ) : active === 'calls' ? (
            <CallsHub
              onSaved={handleCallSaved}
              autoStartFromDetection={pendingCallAutoStart}
              onAutoStartFromDetectionConsumed={() => setPendingCallAutoStart(false)}
              ambientAutoStart={ambientAutoStart}
              onAmbientAutoStartConsumed={() => setAmbientAutoStart(null)}
              onAmbientAutoStartResult={handleAmbientAutoStartResult}
              remoteStopToken={remoteStopToken}
              remotePauseToken={remotePauseToken}
              initialCallId={openCallId}
              onInitialCallConsumed={() => setOpenCallId(null)}
            />
          ) : active === 'past-calls' ? (
            <PastCallsView
              initialSelectedId={openCallId}
              onInitialSelectionConsumed={() => setOpenCallId(null)}
            />
          ) : active === 'tasks' ? (
            <TasksView />
          ) : active === 'pipeline' ? (
            <PipelineHub
              initialContactId={openContactId}
              initialDealId={openDealId}
              onInitialCrmSelectionConsumed={() => {
                setOpenContactId(null)
                setOpenDealId(null)
              }}
              deepLinkEventId={deepLinkEventId}
              onDeepLinkConsumed={() => setDeepLinkEventId(null)}
            />
          ) : active === 'crm' ? (
            <CrmView
              initialContactId={openContactId}
              initialDealId={openDealId}
              onInitialSelectionConsumed={() => {
                setOpenContactId(null)
                setOpenDealId(null)
              }}
            />
          ) : active === 'calendar' ? (
            <CalendarView
              deepLinkEventId={deepLinkEventId}
              onDeepLinkConsumed={() => setDeepLinkEventId(null)}
            />
          ) : active === 'coaching' ? (
            navPreviewEnabled ? <CoachingHub /> : <CoachingView />
          ) : active === 'analytics' ? (
            <AnalyticsView />
          ) : active === 'library' ? (
            <LibraryHub />
          ) : active === 'knowledge' ? (
            <KnowledgeView />
          ) : active === 'team' ? (
            <TeamView />
          ) : (
            <PlaceholderView
              title={activeItem.label}
              icon={activeItem.icon}
              onNavigate={navigateTo}
            />
          )}
        </Suspense>
      </div>
      {palette}
    </AppShell>
  )
}
