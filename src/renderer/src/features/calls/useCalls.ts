import { useCallback, useEffect, useRef, useState } from 'react'
import type { Call, CallSummary } from './types'

// A saved call's transcript/audio are more consequential to lose than a task
// or deal, so the real (irreversible) delete is held behind this window —
// same "optimistic hide + real delete after a grace period" pattern used
// elsewhere, giving the Undo toast time to act before anything is gone.
const DELETE_GRACE_MS = 6000

interface UseCalls {
  calls: CallSummary[]
  loading: boolean
  remove: (id: string) => Promise<void>
  undoDelete: (id: string) => void
  get: (id: string) => Promise<Call | null>
  refresh: () => Promise<void>
}

export function useCalls(): UseCalls {
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set())
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.calls.list()
      setCalls(list)
    } catch {
      /* keep the last known list */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time data fetch; state set only after the await
    void refresh()
  }, [refresh])

  useEffect(() => {
    // A cloud restore can bring back call metadata (never the transcript) in
    // the background; re-read so Past Calls reflects it automatically.
    return window.api.backup.onChanged(() => void refresh())
  }, [refresh])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      // A pending delete already told the user "deleted, with an Undo option"
      // — hiding it in `pendingDeleteIds` and showing the toast. Just clearing
      // the timer here (without ever calling calls.delete) would silently
      // resurrect it: navigate away inside the 6s window (this hook unmounts
      // per-tab, per MainApp's `key={active}` remount) and the call the user
      // believes is gone — transcript included — comes back next time Past
      // Calls loads. The promise the UI already made has to be honored, not
      // cancelled — fire the real delete for every call still pending instead
      // of dropping it.
      for (const [id, timer] of timers) {
        clearTimeout(timer)
        void window.api.calls.delete(id).catch(() => {
          /* nothing left mounted to report this to; best-effort */
        })
      }
      timers.clear()
    }
  }, [])

  const remove = useCallback(
    async (id: string) => {
      // Optimistic hide: the call disappears from the list immediately, but the
      // real (irreversible) delete only fires after the grace period — giving
      // the Undo toast a real window to act in before the transcript is gone.
      setPendingDeleteIds((prev) => new Set(prev).add(id))
      const timer = setTimeout(() => {
        timersRef.current.delete(id)
        void (async () => {
          try {
            await window.api.calls.delete(id)
          } catch {
            /* ignore — refresh reflects the true state */
          }
          setPendingDeleteIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          await refresh()
        })()
      }, DELETE_GRACE_MS)
      timersRef.current.set(id, timer)
    },
    [refresh]
  )

  const undoDelete = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setPendingDeleteIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const get = useCallback((id: string) => window.api.calls.get(id), [])

  const visibleCalls = pendingDeleteIds.size
    ? calls.filter((c) => !pendingDeleteIds.has(c.id))
    : calls

  return { calls: visibleCalls, loading, remove, undoDelete, get, refresh }
}
