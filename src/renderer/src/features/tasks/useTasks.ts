import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@renderer/features/notifications/useToast'
import type { Task } from './types'

// Derive the create/update payload shapes straight from the preload bridge so
// they can never drift from what the main process actually accepts.
export type TaskCreateInput = Parameters<typeof window.api.tasks.create>[0]
export type TaskUpdateInput = Parameters<typeof window.api.tasks.update>[1]

export interface UseTasks {
  tasks: Task[]
  loading: boolean
  refresh: () => Promise<void>
  create: (input: TaskCreateInput) => Promise<void>
  update: (id: string, patch: TaskUpdateInput) => Promise<void>
  /** Optimistically hides the task and schedules the real delete ~6s later,
   *  giving `undoDelete` a window to cancel it. */
  remove: (id: string) => void
  /** Cancels a pending delete started by `remove`, so the task reappears and
   *  is never actually deleted. */
  undoDelete: (id: string) => void
}

/** How long a deleted task stays recoverable via the "Undo" toast action
 *  before the delete actually hits disk. */
const UNDO_WINDOW_MS = 6000

export function useTasks(): UseTasks {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const toast = useToast()

  useEffect(() => {
    mountedRef.current = true
    const timeouts = timeoutsRef.current
    return () => {
      mountedRef.current = false
      // A pending delete already told the user "deleted, with an Undo option"
      // — hiding it in `pendingDeleteIds` and showing the toast. Just clearing
      // the timer here (without ever calling tasks.delete) would silently
      // resurrect it: navigate away inside the 6s window and the task the
      // user believes is gone comes back the next time this list loads. The
      // promise the UI already made has to be honored, not cancelled — fire
      // the real delete for every task still pending instead of dropping it.
      for (const [id, handle] of timeouts) {
        clearTimeout(handle)
        void window.api.tasks.delete(id).catch(() => {
          /* nothing left mounted to report this to; best-effort */
        })
      }
      timeouts.clear()
    }
  }, [])

  // State is only set after the await (and only while mounted), so this is
  // safe to call straight from an effect without extra render churn.
  const refresh = useCallback(async () => {
    try {
      const list = await window.api.tasks.list()
      if (!mountedRef.current) return
      setTasks(list)
    } catch {
      /* keep the last known list */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Load tasks once on mount. The rule flags any setState reachable from an
    // effect, but a mount-time data fetch (state set only after the await, and
    // only while mounted) is exactly the intended pattern here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  useEffect(() => {
    // A cloud restore can create/update/delete tasks in the background; re-read
    // so the list reflects it without needing a manual re-navigation.
    return window.api.backup.onChanged(() => void refresh())
  }, [refresh])

  const create = useCallback(
    async (input: TaskCreateInput) => {
      await window.api.tasks.create(input)
      await refresh()
    },
    [refresh]
  )

  const update = useCallback(
    async (id: string, patch: TaskUpdateInput) => {
      await window.api.tasks.update(id, patch)
      await refresh()
    },
    [refresh]
  )

  const remove = useCallback(
    (id: string) => {
      setPendingDeleteIds((prev) => new Set(prev).add(id))
      const handle = setTimeout(() => {
        timeoutsRef.current.delete(id)
        void (async () => {
          try {
            await window.api.tasks.delete(id)
          } catch {
            toast.error('Could not delete the task. Please try again.')
          }
          if (mountedRef.current) {
            setPendingDeleteIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }
          await refresh()
        })()
      }, UNDO_WINDOW_MS)
      timeoutsRef.current.set(id, handle)
    },
    [refresh, toast]
  )

  const undoDelete = useCallback((id: string) => {
    const handle = timeoutsRef.current.get(id)
    if (handle) {
      clearTimeout(handle)
      timeoutsRef.current.delete(id)
    }
    setPendingDeleteIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const visibleTasks = tasks.filter((t) => !pendingDeleteIds.has(t.id))

  return { tasks: visibleTasks, loading, refresh, create, update, remove, undoDelete }
}
