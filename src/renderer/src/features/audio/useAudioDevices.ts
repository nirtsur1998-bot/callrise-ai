import { useCallback, useEffect, useState } from 'react'
import { getSelectedMicId, setSelectedMicId } from './devices'

export interface AudioDevice {
  deviceId: string
  label: string
}

interface UseAudioDevices {
  mics: AudioDevice[]
  /** Label of the current system output (informational — we can't change it). */
  outputLabel: string | null
  selectedMicId: string
  chooseMic: (id: string) => void
  refresh: () => void
}

/** Enumerate audio devices and remember the chosen mic. Device labels only
 *  appear once the app has microphone permission (which it gets on first call). */
export function useAudioDevices(): UseAudioDevices {
  const [mics, setMics] = useState<AudioDevice[]>([])
  const [outputLabel, setOutputLabel] = useState<string | null>(null)
  const [selectedMicId, setSel] = useState<string>(() => getSelectedMicId())

  const refresh = useCallback((): void => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const ins = devices.filter((d) => d.kind === 'audioinput')
        setMics(
          ins.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
        )

        const out =
          devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default') ??
          devices.find((d) => d.kind === 'audiooutput')
        // macOS labels the default like "Default - MacBook Pro Speakers"; tidy it.
        const label = out?.label ? out.label.replace(/^Default\s*-\s*/i, '') : null
        setOutputLabel(label)
      })
      .catch(() => {
        /* enumeration can fail transiently; keep the last known list */
      })
  }, [])

  useEffect(() => {
    refresh()
    const handler = (): void => refresh()
    navigator.mediaDevices.addEventListener?.('devicechange', handler)
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', handler)
  }, [refresh])

  const chooseMic = useCallback((id: string): void => {
    setSelectedMicId(id)
    setSel(id)
  }, [])

  return { mics, outputLabel, selectedMicId, chooseMic, refresh }
}
