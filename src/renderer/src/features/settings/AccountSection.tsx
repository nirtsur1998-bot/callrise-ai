import { LogOut } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { useAuth } from '@renderer/features/auth/useAuth'
import { AudioSourcesCard } from '@renderer/features/audio/AudioSourcesCard'

export function AccountSection(): React.JSX.Element {
  const { loading, configured, user } = useAuth()

  const signOut = (): void => {
    void window.api.auth.signOut() // the gate swaps back to the login screen via the broadcast
  }

  return (
    <>
      <Card className="mb-5">
        {!configured ? (
          <p className="text-[13px] text-muted">
            Account sign-in isn&rsquo;t set up for this build.
          </p>
        ) : loading ? (
          <p className="text-[13px] text-faint">Loading account…</p>
        ) : user ? (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name || user.email}</p>
              {user.name && <p className="truncate text-[13px] text-muted">{user.email}</p>}
            </div>
            <button
              type="button"
              onClick={signOut}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        ) : (
          <p className="text-[13px] text-muted">Not signed in.</p>
        )}
      </Card>

      <AudioSourcesCard />
    </>
  )
}
