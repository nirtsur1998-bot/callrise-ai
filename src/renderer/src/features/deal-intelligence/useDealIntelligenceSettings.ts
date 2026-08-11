import { useCallback, useState } from 'react'
import type { NudgeType, Sensitivity } from './nudgeEngine'

// On/off + sensitivity + per-cue-type + analysis-frequency preferences for
// the M24 Live Deal Intelligence beta, remembered locally — same storage
// pattern as features/live/useCueSettings.ts (renderer-only localStorage is
// sufficient here because every one of these only gates whether/how THIS
// process makes an IPC/AI call; main never needs to know about them
// independently, unlike e.g. detection.enabled).
const KEY_ENABLED = 'salesos.dealIntelligence.enabled'
const KEY_SENS = 'salesos.dealIntelligence.sensitivity'
const KEY_TYPES = 'salesos.dealIntelligence.enabledTypes'
const KEY_FREQUENCY = 'salesos.dealIntelligence.frequency'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* localStorage unavailable — just use the in-memory value this session */
  }
}

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

const DEFAULT_ENABLED_TYPES: EnabledNudgeTypes = { risk: true, opportunity: true, tactical: true }

function readEnabledTypes(): EnabledNudgeTypes {
  const raw = read(KEY_TYPES)
  if (!raw) return DEFAULT_ENABLED_TYPES
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return DEFAULT_ENABLED_TYPES
    const p = parsed as Record<string, unknown>
    return {
      risk: typeof p.risk === 'boolean' ? p.risk : true,
      opportunity: typeof p.opportunity === 'boolean' ? p.opportunity : true,
      tactical: typeof p.tactical === 'boolean' ? p.tactical : true
    }
  } catch {
    return DEFAULT_ENABLED_TYPES
  }
}

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
  const [enabled, setEnabledState] = useState<boolean>(() => read(KEY_ENABLED) === 'true')
  const [sensitivity, setSensitivityState] = useState<Sensitivity>(() => {
    const v = read(KEY_SENS)
    return v === 'quiet' || v === 'balanced' || v === 'aggressive' ? v : 'balanced'
  })
  const [enabledTypes, setEnabledTypesState] = useState<EnabledNudgeTypes>(readEnabledTypes)
  const [frequency, setFrequencyState] = useState<AnalysisFrequency>(() => {
    const v = read(KEY_FREQUENCY)
    return v === 'frequent' || v === 'balanced' || v === 'infrequent' ? v : 'balanced'
  })

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v)
    write(KEY_ENABLED, String(v))
  }, [])

  const setSensitivity = useCallback((s: Sensitivity) => {
    setSensitivityState(s)
    write(KEY_SENS, s)
  }, [])

  const setTypeEnabled = useCallback((type: NudgeType, on: boolean) => {
    setEnabledTypesState((prev) => {
      // Never let the rep disable every type at once — that's functionally
      // the same as turning the whole feature off, but silently, from a
      // control that doesn't say "off." The master toggle above is the one
      // honest way to fully disable this.
      const next = { ...prev, [type]: on }
      if (ALL_NUDGE_TYPES.every((t) => !next[t])) return prev
      write(KEY_TYPES, JSON.stringify(next))
      return next
    })
  }, [])

  const setFrequency = useCallback((f: AnalysisFrequency) => {
    setFrequencyState(f)
    write(KEY_FREQUENCY, f)
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
