import { useState } from 'react'
import { AudioLines } from 'lucide-react'
import { useAuth } from '@renderer/features/auth/useAuth'
import { AuthScreen } from '@renderer/features/auth/AuthScreen'
import { useTheme } from '@renderer/features/settings/useTheme'
import { OnboardingFlow, type OnboardingExit } from '@renderer/features/onboarding/OnboardingFlow'
import { isOnboardingComplete } from '@renderer/features/onboarding/prefs'
import { ToastProvider } from '@renderer/features/notifications/ToastProvider'
import type { NavId } from '@renderer/features/navigation/nav-items'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
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
        <ErrorBoundary>
          <MainApp user={user} initialNav={initialNav} />
        </ErrorBoundary>
      )}
    </ToastProvider>
  )
}

export default App
