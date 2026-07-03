import { useCallback, useEffect, useState } from 'react'
import type { Call, CallSummary } from './types'

interface UseCalls {
  calls: CallSummary[]
  loading: boolean
  remove: (id: string) => Promise<void>
  get: (id: string) => Promise<Call | null>
  refresh: () => Promise<void>
}

export function useCalls(): UseCalls {
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [loading, setLoading] = useState(true)

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
    void refresh()
  }, [refresh])

  const remove = useCallback(
    async (id: string) => {
      try {
        await window.api.calls.delete(id)
      } catch {
        /* ignore — refresh reflects the true state */
      }
      await refresh()
    },
    [refresh]
  )

  const get = useCallback((id: string) => window.api.calls.get(id), [])

  return { calls, loading, remove, get, refresh }
}
