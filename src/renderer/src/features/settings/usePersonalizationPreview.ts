import { useCallback, useEffect, useRef, useState } from 'react'

export type PersonalizationPreview = Awaited<
  ReturnType<typeof window.api.settings.previewPersonalization>
>

export interface UsePersonalizationPreview {
  preview: PersonalizationPreview | null
  loading: boolean
}

/** Re-fetches the assembled "about the rep" preview whenever `refreshKey`
 *  changes (pass something that changes after a personalization field saves). */
export function usePersonalizationPreview(refreshKey: unknown): UsePersonalizationPreview {
  const [preview, setPreview] = useState<PersonalizationPreview | null>(null)
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
      const next = await window.api.settings.previewPersonalization()
      if (mountedRef.current) setPreview(next)
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

  return { preview, loading }
}
