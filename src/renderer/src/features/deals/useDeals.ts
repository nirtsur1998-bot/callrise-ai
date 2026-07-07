import { useCallback, useEffect, useRef, useState } from 'react'
import type { Deal } from './types'

export type DealCreateInput = Parameters<typeof window.api.deals.create>[0]
export type DealUpdateInput = Parameters<typeof window.api.deals.update>[1]

export interface UseDeals {
  deals: Deal[]
  loading: boolean
  refresh: () => Promise<void>
  create: (input: DealCreateInput) => Promise<Deal | null>
  update: (id: string, patch: DealUpdateInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function useDeals(): UseDeals {
  const [deals, setDeals] = useState<Deal[]>([])
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
      const list = await window.api.deals.list()
      if (!mountedRef.current) return
      setDeals(list)
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
    // A cloud restore can add/update/delete deals in the background (when
    // Contacts & deals sync is opted into) — re-read so the list reflects it.
    return window.api.backup.onChanged(() => void refresh())
  }, [refresh])

  const create = useCallback(
    async (input: DealCreateInput) => {
      const deal = await window.api.deals.create(input)
      await refresh()
      return deal
    },
    [refresh]
  )

  const update = useCallback(
    async (id: string, patch: DealUpdateInput) => {
      await window.api.deals.update(id, patch)
      await refresh()
    },
    [refresh]
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.deals.delete(id)
      await refresh()
    },
    [refresh]
  )

  return { deals, loading, refresh, create, update, remove }
}
