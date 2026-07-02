import { useCallback, useEffect, useRef, useState } from 'react'
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
  remove: (id: string) => Promise<void>
}

export function useTasks(): UseTasks {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
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
    async (id: string) => {
      await window.api.tasks.delete(id)
      await refresh()
    },
    [refresh]
  )

  return { tasks, loading, refresh, create, update, remove }
}
