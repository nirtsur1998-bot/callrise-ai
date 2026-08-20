import { useCallback, useEffect, useRef, useState } from 'react'
import { tier1UiState, type Tier1UiState } from '@renderer/features/live/audio/tier1-source'
import type { Tier1Status } from '@renderer/features/live/audio/tier1-types'
import {
  getTier1Enabled,
  setTier1Enabled,
  getDenoiseStrength,
  setDenoiseStrength,
  type DenoiseStrength
} from '@renderer/features/settings/prefs'

export interface UseTier1 {
  /** Raw status from the pipe client, or null before the first read. */
  status: Tier1Status | null
  /** The persisted opt-in preference (see getTier1Enabled's own doc comment
   *  on prefs.ts — off by default, read once per call, not a live switch). */
  enabled: boolean
  setEnabled: (value: boolean) => void
  /** Denoise strength preference. Like `enabled`, read by recorder.ts at
   *  call start — changing it mid-call affects the NEXT call. */
  strength: DenoiseStrength
  setStrength: (value: DenoiseStrength) => void
  /** Exactly what the pipeline reports — 'unavailable' | 'off' | 'starting'
   *  | 'active' | 'model-missing'. Do not derive a different taxonomy from
   *  `status` elsewhere; this is the one place that computes it. */
  uiState: Tier1UiState
}

/**
 * Windows Tier 1 settings hook — reads live status from `window.api.tier1`
 * and the persisted on/off preference from prefs.ts.
 *
 * DELIBERATELY NOT `useVirtualMic`'s shape. That hook's start/stop calls are
 * meaningful because macOS's Tier 2 helper is a persistent system service —
 * toggling it there and then has an immediate engine to start or stop. Tier 1
 * has no such standalone existence: it is spawned by recorder.ts, scoped to
 * one call, with the ACTUAL mic name that call resolved. There is nothing
 * this hook could call `start()` on outside a live call, so it doesn't try —
 * `setEnabled` only ever writes the preference. See Tier1SettingsCard for
 * how that constraint shapes the copy shown to the user.
 */
export function useTier1(): UseTier1 {
  const [status, setStatus] = useState<Tier1Status | null>(null)
  const [enabled, setEnabledState] = useState<boolean>(() => getTier1Enabled())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    window.api.tier1
      .getStatus()
      .then((s) => {
        if (mountedRef.current) setStatus(s)
      })
      .catch(() => {
        /* leaves status null — uiState degrades to 'unavailable', the safe read */
      })
    return window.api.tier1.onStatus((s) => {
      if (mountedRef.current) setStatus(s)
    })
  }, [])

  const setEnabled = useCallback((value: boolean): void => {
    setTier1Enabled(value)
    setEnabledState(value)
  }, [])

  const [strength, setStrengthState] = useState<DenoiseStrength>(() => getDenoiseStrength())
  const setStrength = useCallback((value: DenoiseStrength): void => {
    setDenoiseStrength(value)
    setStrengthState(value)
  }, [])

  return {
    status,
    enabled,
    setEnabled,
    strength,
    setStrength,
    uiState: tier1UiState(status, enabled)
  }
}
