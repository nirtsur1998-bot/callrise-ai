import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgeEntry } from './types'

// Derive the create/update payload shapes straight from the preload bridge so
// they can never drift from what the main process actually accepts.
export type KnowledgeCreateInput = Parameters<typeof window.api.knowledge.create>[0]
export type KnowledgeUpdateInput = Parameters<typeof window.api.knowledge.update>[1]

export interface UseKnowledge {
  entries: KnowledgeEntry[]
  loading: boolean
  refresh: () => Promise<void>
  create: (input: KnowledgeCreateInput) => Promise<void>
  update: (id: string, patch: KnowledgeUpdateInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function useKnowledge(): UseKnowledge {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
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
      const list = await window.api.knowledge.list()
      if (!mountedRef.current) return
      setEntries(list)
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
    // A cloud restore can add/update/delete entries in the background (when
    // Knowledge Base sync is opted into) — re-read so the list reflects it.
    return window.api.backup.onChanged(() => void refresh())
  }, [refresh])

  const create = useCallback(
    async (input: KnowledgeCreateInput) => {
      await window.api.knowledge.create(input)
      await refresh()
    },
    [refresh]
  )

  const update = useCallback(
    async (id: string, patch: KnowledgeUpdateInput) => {
      await window.api.knowledge.update(id, patch)
      await refresh()
    },
    [refresh]
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.knowledge.delete(id)
      await refresh()
    },
    [refresh]
  )

  return { entries, loading, refresh, create, update, remove }
}
