import { useCallback, useEffect, useRef, useState } from 'react'
import type { ObjectionQueueItem } from './types'

export type ObjectionApproveEdits = Parameters<typeof window.api.objectionQueue.approve>[1]

export interface UseObjectionQueue {
  items: ObjectionQueueItem[]
  loading: boolean
  refresh: () => Promise<void>
  approve: (id: string, edits?: ObjectionApproveEdits) => Promise<boolean>
  reject: (id: string) => Promise<void>
}

export function useObjectionQueue(): UseObjectionQueue {
  const [items, setItems] = useState<ObjectionQueueItem[]>([])
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
      const list = await window.api.objectionQueue.list()
      if (mountedRef.current) setItems(list)
    } catch {
      /* keep the last known list */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const approve = useCallback(
    async (id: string, edits?: ObjectionApproveEdits) => {
      const res = await window.api.objectionQueue.approve(id, edits)
      await refresh()
      return res.ok
    },
    [refresh]
  )

  const reject = useCallback(
    async (id: string) => {
      await window.api.objectionQueue.reject(id)
      await refresh()
    },
    [refresh]
  )

  return { items, loading, refresh, approve, reject }
}
