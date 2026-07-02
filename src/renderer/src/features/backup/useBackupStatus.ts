import { useCallback, useEffect, useRef, useState } from 'react'

// Derive the status shape straight from the preload bridge so it can never
// drift from what the main process actually returns.
export type BackupStatus = Awaited<ReturnType<typeof window.api.backup.getStatus>>

export interface UseBackupStatus {
  status: BackupStatus | null
  syncing: boolean
  loading: boolean
  /** Full sync now: restore (pull + reconcile) then push. Drives the button. */
  syncNow: () => Promise<void>
}

/**
 * Backup status for the Settings screen: reads the last-synced/last-error
 * state, refreshes it after a restore changes local data (backup:onChanged),
 * and drives the manual "Sync now" button.
 */
export function useBackupStatus(): UseBackupStatus {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const s = await window.api.backup.getStatus()
      if (mountedRef.current) setStatus(s)
    } catch {
      /* keep the last known status */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  useEffect(() => {
    // A background sync (launch, periodic, or another screen's action) can
    // change the status too — keep this screen live without polling.
    return window.api.backup.onChanged(() => void refresh())
  }, [refresh])

  const syncNow = useCallback(async () => {
    setSyncing(true)
    try {
      await window.api.backup.syncNow()
    } catch {
      /* the status refresh below reflects the failure via lastError */
    } finally {
      await refresh()
      if (mountedRef.current) setSyncing(false)
    }
  }, [refresh])

  return { status, syncing, loading, syncNow }
}
