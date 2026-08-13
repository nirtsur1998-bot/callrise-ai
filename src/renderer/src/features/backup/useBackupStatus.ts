import { useCallback, useEffect, useRef, useState } from 'react'
import { useSingletonJob } from '@renderer/features/jobs/useSingletonJob'

// Derive the status shape straight from the preload bridge so it can never
// drift from what the main process actually returns.
export type BackupStatus = Awaited<ReturnType<typeof window.api.backup.getStatus>>

/** M26 Phase 3 — the manual "Sync now" button's job (main/backup.ts). */
const SYNC_JOB_TYPE = 'backup:sync'

/** Which half of the sync is running right now, or null when idle.
 *  A "sync" is two very different operations back to back — pulling other
 *  devices' changes DOWN, then pushing this device's changes UP — and the
 *  card used to show one undifferentiated "Syncing…" for both. */
export type SyncPhase = 'waiting' | 'restoring' | 'backing-up'

export interface UseBackupStatus {
  status: BackupStatus | null
  syncing: boolean
  /** null unless a manual sync is in flight. */
  phase: SyncPhase | null
  loading: boolean
  /** Full sync now: restore (pull + reconcile) then push. Drives the button. */
  syncNow: () => Promise<void>
}

/** Maps the job's own stage label back to a phase. The label is authored in
 *  main (backup.ts) precisely so the Activity Center shows something
 *  readable too; this recovers the structured phase for the card's own
 *  wording without a second source of truth. */
function phaseFromStageLabel(label: string): SyncPhase {
  if (label.startsWith('Restoring')) return 'restoring'
  if (label.startsWith('Backing up')) return 'backing-up'
  return 'waiting'
}

/**
 * Backup status for the Settings screen: reads the last-synced/last-error
 * state, refreshes it after a restore changes local data (backup:onChanged),
 * and drives the manual "Sync now" button.
 *
 * M26 Phase 3 — the button now enqueues a MAINTENANCE-lane job and tracks
 * it, so leaving Settings mid-sync no longer loses the progress display, and
 * the card can finally say WHICH half is running.
 */
export function useBackupStatus(): UseBackupStatus {
  const [status, setStatus] = useState<BackupStatus | null>(null)
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

  // Adopts an already-running sync on mount — that IS the navigation fix:
  // opening Settings mid-sync now shows real progress instead of an idle
  // button, and leaving/returning no longer resets it.
  const [job, startJob] = useSingletonJob(SYNC_JOB_TYPE, {
    onSucceeded: () => void refresh(),
    onFailed: () => void refresh()
  })

  const syncing = job?.state === 'running' || job?.state === 'queued'
  const phase = syncing
    ? job?.progress.mode === 'stages'
      ? phaseFromStageLabel(job.progress.stageLabel)
      : 'waiting'
    : null

  const syncNow = useCallback(async () => {
    try {
      const res = await window.api.backup.syncNow()
      if (res.ok && res.jobId) {
        const fresh = await window.api.jobs.get(res.jobId)
        if (mountedRef.current && fresh) startJob(fresh)
      }
    } catch {
      /* the status refresh reflects any failure via lastPushError/lastPullError */
      await refresh()
    }
  }, [refresh, startJob])

  return { status, syncing, phase, loading, syncNow }
}
