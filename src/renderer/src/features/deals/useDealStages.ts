import { useCallback, useEffect, useRef, useState } from 'react'
import type { DealStage, SetDealStagesResult } from './types'

export interface UseDealStages {
  stages: DealStage[]
  loading: boolean
  refresh: () => Promise<void>
  /** Replace the whole ordered list. Fails with 'stage-in-use' if a removed
   *  stage still has deals sitting in it. */
  save: (stages: DealStage[]) => Promise<SetDealStagesResult>
}

export function useDealStages(): UseDealStages {
  const [stages, setStages] = useState<DealStage[]>([])
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
      const list = await window.api.dealStages.get()
      if (!mountedRef.current) return
      setStages(list)
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

  useEffect(() => {
    // A cloud restore can replace the stage list in the background — re-read
    // so the pipeline columns reflect it.
    return window.api.backup.onChanged(() => void refresh())
  }, [refresh])

  const save = useCallback(
    async (next: DealStage[]) => {
      const result = await window.api.dealStages.set(next)
      if (result.ok) await refresh()
      return result
    },
    [refresh]
  )

  return { stages, loading, refresh, save }
}
