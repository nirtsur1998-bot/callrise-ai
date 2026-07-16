import { useEffect, useRef, useState } from 'react'
import { LogOut } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { fieldClass } from '@renderer/components/field'
import { cn } from '@renderer/lib/cn'
import { useAuth } from '@renderer/features/auth/useAuth'
import { AudioSourcesCard } from '@renderer/features/audio/AudioSourcesCard'

export function AccountSection(): React.JSX.Element {
  const { loading, configured, user } = useAuth()
  const [name, setName] = useState(user?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(savedTimeout.current), [])

  // Keep the draft in sync with the real value once it loads (or changes
  // elsewhere, e.g. after a save broadcasts back).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync edit draft from the loaded/updated auth user
    setName(user?.name ?? '')
  }, [user?.name])

  const signOut = (): void => {
    void window.api.auth.signOut() // the gate swaps back to the login screen via the broadcast
  }

  const commitName = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === user?.name) return
    setSaving(true)
    try {
      await window.api.auth.updateName(trimmed)
      // useAuth's onChange subscription picks up the broadcasted new name.
      setSaved(true)
      clearTimeout(savedTimeout.current)
      savedTimeout.current = setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
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
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-muted">
                Name
                {saved && <span className="text-[12px] text-positive">Saved</span>}
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void commitName()}
                disabled={saving}
                placeholder="Your name"
                className={cn(fieldClass, 'max-w-sm')}
              />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-line-soft pt-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-muted">Email</p>
                <p className="truncate text-sm">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={signOut}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition hover:bg-elevated hover:text-ink"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted">Not signed in.</p>
        )}
      </Card>

      <AudioSourcesCard />
    </>
  )
}
