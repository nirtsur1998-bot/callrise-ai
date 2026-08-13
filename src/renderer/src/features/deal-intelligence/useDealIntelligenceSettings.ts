import { useCallback, useEffect, useRef, useState } from 'react'
import type { NudgeType, Sensitivity } from './nudgeEngine'

// M26 Phase 4.5.2 — moved from renderer-only localStorage
// (salesos.dealIntelligence.*) to main's AppSettings (app-settings.ts's
// dealIntelligence field), so main can read this once the engine itself
// moves into main (4.5.3) — main cannot gate its own AI-call cadence on a
// value that only ever existed inside a React hook. External shape is
// unchanged; every call site (LiveCallProvider, LiveDealIntelligenceSection)
// keeps working as-is.
//
// Each hook instance loads once from main on mount and writes back through
// IPC on every setter call — same "no cross-instance live sync" behavior
// localStorage had here before, so multiple simultaneous instances behave
// identically to before this migration.

export type AnalysisFrequency = 'frequent' | 'balanced' | 'infrequent'

/** Multiplies useDealIntelligence.ts's base Tier 1 (~20s)/Tier 2 (~2.5min)
 *  intervals — 'balanced' is exactly the spec's own numbers; the other two
 *  scale both cadences together rather than exposing raw millisecond knobs
 *  a non-technical founder has no way to reason about. */
export const FREQUENCY_MULTIPLIER: Record<AnalysisFrequency, number> = {
  frequent: 0.5,
  balanced: 1,
  infrequent: 2
}

const ALL_NUDGE_TYPES: NudgeType[] = ['risk', 'opportunity', 'tactical']

export interface EnabledNudgeTypes {
  risk: boolean
  opportunity: boolean
  tactical: boolean
}

// Same defaults main's own sanitizeDealIntelligence()/sanitizeEnabledTypes()
// fall back to — shown until the real value has loaded.
const DEFAULT_ENABLED_TYPES: EnabledNudgeTypes = { risk: true, opportunity: true, tactical: true }
const DEFAULT_ENABLED = false // Beta — off by default
const DEFAULT_SENSITIVITY: Sensitivity = 'balanced'
const DEFAULT_FREQUENCY: AnalysisFrequency = 'balanced'

export interface DealIntelligenceSettings {
  enabled: boolean
  setEnabled: (v: boolean) => void
  sensitivity: Sensitivity
  setSensitivity: (s: Sensitivity) => void
  /** Which of risk/opportunity/tactical the rep wants surfaced at all — a
   *  disabled type is filtered out before it ever reaches the Nudge Engine
   *  (see useDealIntelligence.ts), not just hidden in the UI. */
  enabledTypes: EnabledNudgeTypes
  setTypeEnabled: (type: NudgeType, on: boolean) => void
  frequency: AnalysisFrequency
  setFrequency: (f: AnalysisFrequency) => void
}

export function useDealIntelligenceSettings(): DealIntelligenceSettings {
  // Off by default — this is a Beta feature that makes real, metered AI
  // calls mid-call; opting in should be a deliberate choice, unlike live
  // coaching cues (M9, on by default) which shipped as a mature core feature.
  const [enabled, setEnabledState] = useState<boolean>(DEFAULT_ENABLED)
  const [sensitivity, setSensitivityState] = useState<Sensitivity>(DEFAULT_SENSITIVITY)
  const [enabledTypes, setEnabledTypesState] = useState<EnabledNudgeTypes>(DEFAULT_ENABLED_TYPES)
  const [frequency, setFrequencyState] = useState<AnalysisFrequency>(DEFAULT_FREQUENCY)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    window.api.settings
      .get()
      .then((s) => {
        if (!mountedRef.current) return
        const d = s.dealIntelligence
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time load of the real value from main
        setEnabledState(d.enabled)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSensitivityState(d.sensitivity)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEnabledTypesState(d.enabledTypes)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFrequencyState(d.frequency)
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
    void window.api.settings.update({ dealIntelligence: { enabled: v } })
  }, [])

  const setSensitivity = useCallback((s: Sensitivity) => {
    setSensitivityState(s)
    void window.api.settings.update({ dealIntelligence: { sensitivity: s } })
  }, [])

  const setTypeEnabled = useCallback((type: NudgeType, on: boolean) => {
    setEnabledTypesState((prev) => {
      // Never let the rep disable every type at once — that's functionally
      // the same as turning the whole feature off, but silently, from a
      // control that doesn't say "off." The master toggle above is the one
      // honest way to fully disable this. Main's own mergeEnabledTypes()
      // enforces the identical guard, so a patch that would violate it is a
      // no-op there too — this local check just avoids the round trip.
      const next = { ...prev, [type]: on }
      if (ALL_NUDGE_TYPES.every((t) => !next[t])) return prev
      void window.api.settings.update({ dealIntelligence: { enabledTypes: { [type]: on } } })
      return next
    })
  }, [])

  const setFrequency = useCallback((f: AnalysisFrequency) => {
    setFrequencyState(f)
    void window.api.settings.update({ dealIntelligence: { frequency: f } })
  }, [])

  return {
    enabled,
    setEnabled,
    sensitivity,
    setSensitivity,
    enabledTypes,
    setTypeEnabled,
    frequency,
    setFrequency
  }
}
