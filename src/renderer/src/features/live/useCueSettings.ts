import { useCallback, useEffect, useRef, useState } from 'react'
import type { Sensitivity } from './useLiveCues'

// M26 Phase 4.5.2 — moved from renderer-only localStorage
// (salesos.cues.enabled/sensitivity) to main's AppSettings (app-settings.ts's
// liveCues field), so main can read this once the cue engine itself moves
// into main (4.5.4) — main cannot gate its own cadence on a value that only
// ever existed inside a React hook. External shape is unchanged; every call
// site (LiveCallProvider, CopilotPanel, CoachingSection) keeps working as-is.
//
// Each hook instance loads once from main on mount and writes back through
// IPC on every setter call — the same "no cross-instance live sync" behavior
// localStorage had here before (a 'storage' event only ever fires in OTHER
// windows, never the one that wrote it), so multiple simultaneous instances
// behave identically to before this migration.

export interface CueSettings {
  enabled: boolean
  setEnabled: (v: boolean) => void
  sensitivity: Sensitivity
  setSensitivity: (s: Sensitivity) => void
  /** M34 3c — the live screen's Quiet mode (hides the between-turn
   *  instruments). Persisted beside the cue settings; see app-settings.ts. */
  quiet: boolean
  setQuiet: (v: boolean) => void
}

// Same defaults main's own sanitizeLiveCues() falls back to — shown until
// the real value has loaded.
const DEFAULT_ENABLED = true // default ON
const DEFAULT_SENSITIVITY: Sensitivity = 'low' // default calm
const DEFAULT_QUIET = false // default: today's screen

export function useCueSettings(): CueSettings {
  const [enabled, setEnabledState] = useState<boolean>(DEFAULT_ENABLED)
  const [sensitivity, setSensitivityState] = useState<Sensitivity>(DEFAULT_SENSITIVITY)
  const [quiet, setQuietState] = useState<boolean>(DEFAULT_QUIET)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    window.api.settings
      .get()
      .then((s) => {
        if (!mountedRef.current) return
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time load of the real value from main
        setEnabledState(s.liveCues.enabled)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSensitivityState(s.liveCues.sensitivity)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setQuietState(s.liveCues.quiet === true)
      })
      .catch(() => {
        /* keep the defaults shown above */
      })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v)
    void window.api.settings.update({ liveCues: { enabled: v } })
  }, [])

  const setSensitivity = useCallback((s: Sensitivity) => {
    setSensitivityState(s)
    void window.api.settings.update({ liveCues: { sensitivity: s } })
  }, [])

  const setQuiet = useCallback((v: boolean) => {
    setQuietState(v)
    void window.api.settings.update({ liveCues: { quiet: v } })
  }, [])

  return { enabled, setEnabled, sensitivity, setSensitivity, quiet, setQuiet }
}
