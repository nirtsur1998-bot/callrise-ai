import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgeContextPreview } from './types'

export interface UseKnowledgePreview {
  preview: KnowledgeContextPreview | null
  loading: boolean
  refresh: () => Promise<void>
}

/** Re-fetches the assembled AI-context preview whenever `refreshKey` changes
 *  (pass something that changes when entries are added/edited/deleted). */
export function useKnowledgePreview(refreshKey: unknown): UseKnowledgePreview {
  const [preview, setPreview] = useState<KnowledgeContextPreview | null>(null)
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
      const next = await window.api.knowledge.preview()
      if (!mountedRef.current) return
      setPreview(next)
    } catch {
      /* keep the last known preview */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    // refreshKey is deliberately in the deps only to trigger a re-fetch when it changes.
  }, [refresh, refreshKey])

  return { preview, loading, refresh }
}
