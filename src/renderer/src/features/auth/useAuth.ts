import { useEffect, useRef, useState } from 'react'
import type { AuthUser } from './types'

export interface AuthState {
  /** True until we've checked whether someone is already signed in. */
  loading: boolean
  /** False when the .env Supabase keys are missing. */
  configured: boolean
  user: AuthUser | null
}

/**
 * Tracks the signed-in user. Reads the initial status once, then stays in sync
 * with the main process, which broadcasts on login, logout, and token refresh.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ loading: true, configured: false, user: null })
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    // Initial check (state is only set after the await, so no render churn).
    void window.api.auth
      .getStatus()
      .then((s) => {
        if (mountedRef.current) setState({ loading: false, configured: s.configured, user: s.user })
      })
      .catch(() => {
        if (mountedRef.current) setState({ loading: false, configured: false, user: null })
      })

    // Live updates from the main process (login / logout / refresh).
    const unsubscribe = window.api.auth.onChange((user) => {
      if (mountedRef.current) setState((prev) => ({ ...prev, loading: false, user }))
    })
    return unsubscribe
  }, [])

  return state
}
