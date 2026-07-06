import { useCallback, useEffect, useRef, useState } from 'react'

export type AppSettings = Awaited<ReturnType<typeof window.api.settings.get>>
export type AppSettingsPatch = Parameters<typeof window.api.settings.update>[0]

// The safe default (matches main's own fallback) shown until the real value
// loads — never more permissive than what loadAppSettings() would return.
const DEFAULT_SETTINGS: AppSettings = {
  allowOtherPartyRecording: true,
  personalization: { name: '', role: '', pronoun: '', about: '' }
}

export interface UseAppSettings {
  settings: AppSettings
  /** True until the real value has been read from disk at least once. */
  loading: boolean
  update: (patch: AppSettingsPatch) => Promise<void>
}

export function useAppSettings(): UseAppSettings {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
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
      const next = await window.api.settings.get()
      if (mountedRef.current) setSettings(next)
    } catch {
      /* keep the last known (or default) settings */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const update = useCallback(async (patch: AppSettingsPatch) => {
    const next = await window.api.settings.update(patch)
    if (mountedRef.current) setSettings(next)
  }, [])

  return { settings, loading, update }
}
