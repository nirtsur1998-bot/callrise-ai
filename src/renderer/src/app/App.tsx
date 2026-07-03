import { AudioLines } from 'lucide-react'
import { useAuth } from '@renderer/features/auth/useAuth'
import { AuthScreen } from '@renderer/features/auth/AuthScreen'
import { MainApp } from './MainApp'

/** A brief splash while we check whether someone is already signed in. */
function Splash(): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-canvas">
      <div className="grid h-11 w-11 animate-pulse place-items-center rounded-xl bg-linear-to-br from-accent to-[#9b6cf2]">
        <AudioLines className="h-5 w-5 text-white" strokeWidth={2.25} />
      </div>
    </div>
  )
}

/**
 * Login gate: show a splash while checking, the auth screen when logged out,
 * and the full app once a user is signed in.
 */
function App(): React.JSX.Element {
  const { loading, configured, user } = useAuth()

  if (loading) return <Splash />
  if (!user) return <AuthScreen configured={configured} />
  return <MainApp user={user} />
}

export default App
