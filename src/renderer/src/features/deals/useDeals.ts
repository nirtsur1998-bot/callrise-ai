import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@renderer/features/notifications/useToast'
import type { Deal } from './types'

export type DealCreateInput = Parameters<typeof window.api.deals.create>[0]
export type DealUpdateInput = Parameters<typeof window.api.deals.update>[1]

const UNDO_WINDOW_MS = 6000

export interface UseDeals {
  deals: Deal[]
  loading: boolean
  refresh: () => Promise<void>
  create: (input: DealCreateInput) => Promise<Deal | null>
  update: (id: string, patch: DealUpdateInput) => Promise<void>
  /** Optimistically hides the deal and schedules the actual delete after a
   *  short undo window — call `undoDelete` within that window to cancel it. */
  remove: (id: string) => void
  /** Cancels a pending delete started by `remove`, restoring the deal. */
  undoDelete: (id: string) => void
}

export function useDeals(): UseDeals {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const toast = useToast()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const timeouts = timeoutsRef.current
    return () => {
      // A pending delete already told the user "deleted, with an Undo option"
      // — hiding it in `pendingDeleteIds` and showing the toast. Just clearing
      // the timer here (without ever calling deals.delete) would silently
      // resurrect it: navigate away inside the undo window and the deal the
      // user believes is gone comes back the next time this list loads. Fire
      // the real delete for every deal still pending instead of dropping it.
      for (const [id, handle] of timeouts) {
        clearTimeout(handle)
        void window.api.deals.delete(id).catch(() => {
          /* nothing left mounted to report this to; best-effort */
        })
      }
      timeouts.clear()
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
    (id: string) => {
      setPendingDeleteIds((prev) => new Set(prev).add(id))
      const handle = setTimeout(() => {
        timeoutsRef.current.delete(id)
        void (async () => {
          try {
            await window.api.deals.delete(id)
          } catch {
            toast.error('Could not delete the deal. Please try again.')
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

  const visibleDeals =
    pendingDeleteIds.size === 0 ? deals : deals.filter((d) => !pendingDeleteIds.has(d.id))

  return { deals: visibleDeals, loading, refresh, create, update, remove, undoDelete }
}
