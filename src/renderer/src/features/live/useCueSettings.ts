import { useCallback, useState } from 'react'
import type { Sensitivity } from './useLiveCues'

// On/off + sensitivity preference for live coaching cues, remembered locally.
const KEY_ENABLED = 'salesos.cues.enabled'
const KEY_SENS = 'salesos.cues.sensitivity'

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

export interface CueSettings {
  enabled: boolean
  setEnabled: (v: boolean) => void
  sensitivity: Sensitivity
  setSensitivity: (s: Sensitivity) => void
}

export function useCueSettings(): CueSettings {
  const [enabled, setEnabledState] = useState<boolean>(() => read(KEY_ENABLED) !== 'false') // default ON
  const [sensitivity, setSensitivityState] = useState<Sensitivity>(() => {
    const v = read(KEY_SENS)
    return v === 'low' || v === 'medium' || v === 'high' ? v : 'low' // default calm
  })

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v)
    write(KEY_ENABLED, String(v))
  }, [])

  const setSensitivity = useCallback((s: Sensitivity) => {
    setSensitivityState(s)
    write(KEY_SENS, s)
  }, [])

  return { enabled, setEnabled, sensitivity, setSensitivity }
}
