import { useState } from 'react'
import { AudioLines } from 'lucide-react'
import { useAuth } from '@renderer/features/auth/useAuth'
import { AuthScreen } from '@renderer/features/auth/AuthScreen'
import { useTheme } from '@renderer/features/settings/useTheme'
import { useDesignPreview } from '@renderer/features/settings/useDesignPreview'
import { OnboardingFlow, type OnboardingExit } from '@renderer/features/onboarding/OnboardingFlow'
import { isOnboardingComplete } from '@renderer/features/onboarding/prefs'
import { ToastProvider } from '@renderer/features/notifications/ToastProvider'
import type { NavId } from '@renderer/features/navigation/nav-items'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { ActivityCenter } from '@renderer/features/jobs/ActivityCenter'
import { InterruptedCallPrompt } from '@renderer/features/live/InterruptedCallPrompt'
import { LiveCallProvider } from '@renderer/features/live/LiveCallProvider'
import { LiveCallPill } from '@renderer/features/live/LiveCallPill'
import { MainApp } from './MainApp'

/** A brief splash while we check whether someone is already signed in. */
function Splash(): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-canvas">
      <div className="grid h-11 w-11 animate-pulse place-items-center rounded-xl bg-brand">
        <AudioLines className="h-5 w-5 text-white" strokeWidth={2.25} />
      </div>
    </div>
  )
}

/**
 * Login gate: show a splash while checking, the auth screen when logged out,
 * a one-time onboarding flow for a freshly set-up device, then the full app.
 */
function App(): React.JSX.Element {
  useTheme() // applies the saved dark/light/system preference to <html>, app-wide
  useDesignPreview() // applies the M31 redesign (incl. the palette class on <html>)
  const { loading, configured, user } = useAuth()

  // Per-device: has onboarding been finished (or skipped) already?
  const [onboarded, setOnboarded] = useState(isOnboardingComplete)
  const [initialNav, setInitialNav] = useState<NavId>('home')

  const handleOnboardingComplete = (exit: OnboardingExit): void => {
    setInitialNav(exit === 'live-calls' ? 'live-calls' : 'home')
    setOnboarded(true)
  }

  // Toasts wrap the whole gate so success/error feedback is available on every
  // screen (auth, onboarding, and the main app).
  return (
    <ToastProvider>
      {loading ? (
        <Splash />
      ) : !user ? (
        <AuthScreen configured={configured} />
      ) : !onboarded ? (
        <OnboardingFlow onComplete={handleOnboardingComplete} />
      ) : (
        // M26 Phase 4.4 — LiveCallProvider wraps everything below it,
        // including ErrorBoundary. That ordering is deliberate: a render
        // error somewhere unrelated (say, CrmView) must not be able to tear
        // down an in-progress call along with the tree that crashed. The
        // provider owns the transcription session and consent state for the
        // entire signed-in lifetime of the app — it only ever unmounts on
        // sign-out, never on ordinary navigation. See
        // LiveCallProvider.tsx's file header for why that had to be a whole
        // Provider rather than just relocating the Recorder object.
        <LiveCallProvider>
          <ErrorBoundary>
            <MainApp user={user} initialNav={initialNav} />
          </ErrorBoundary>
          {/* A sibling of MainApp, not something rendered from inside it —
              MainApp swaps to a wholly separate tree for Settings, and this
              needs to survive that swap (see ActivityCenter.tsx's own doc
              comment for why that matters here specifically). */}
          <ActivityCenter />
          {/* M26 Phase 4.2 — a sibling for the same reason as ActivityCenter:
              it must survive MainApp's swap to the Settings tree, and it must
              not be unmounted by a navigation the rep happens to make while
              deciding. */}
          <InterruptedCallPrompt />
          {/* M26 Phase 4.6 — same reason again: a rep who navigates to
              Settings (or anywhere else) mid-call should still be able to see
              the call is running and get back to it, not just discover it's
              still going when they eventually return. See LiveCallPill.tsx's
              own doc comment. */}
          <LiveCallPill />
        </LiveCallProvider>
      )}
    </ToastProvider>
  )
}

export default App
