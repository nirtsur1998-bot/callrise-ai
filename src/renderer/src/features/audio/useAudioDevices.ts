import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getSelectedMicId,
  getSelectedMicLabel,
  hasExplicitMicChoice,
  setSelectedMic,
  subscribeSelectedMic,
  resolveMic,
  type MicResolution
} from './devices'
import { dedupeInputDevices } from './micOutcome'

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
  /** How the current mic was arrived at. Drives the honest warning in the UI:
   *  'missing' means capture is silently using some OTHER microphone. */
  micResolution: MicResolution | null
}

/** Enumerate audio devices and remember the chosen mic. Device labels only
 *  appear once the app has microphone permission (which it gets on first call).
 *
 *  M21: also SELF-HEALS the stored device id. Reinstalling the audio driver
 *  mints new device GUIDs, and because the capture constraint is a soft
 *  `ideal` hint, a stale id doesn't error — the OS just hands back a different
 *  microphone and the app carries on recording the wrong one (BUG-005). On
 *  every enumeration the saved choice is re-resolved by name and the stored id
 *  rewritten, so the next call records from the device the user actually
 *  picked. When it genuinely can't be found, that's surfaced rather than
 *  silently tolerated. */
export function useAudioDevices(preferCallRiseMic = false): UseAudioDevices {
  const [mics, setMics] = useState<AudioDevice[]>([])
  const [outputLabel, setOutputLabel] = useState<string | null>(null)
  const [selectedMicId, setSel] = useState<string>(() => getSelectedMicId())
  const [micResolution, setMicResolution] = useState<MicResolution | null>(null)
  // Read inside refresh without making it a dependency (which would re-subscribe
  // the devicechange listener on every toggle).
  const preferRef = useRef(preferCallRiseMic)
  useEffect(() => {
    preferRef.current = preferCallRiseMic
  }, [preferCallRiseMic])

  const refresh = useCallback((): void => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const ins = devices.filter((d) => d.kind === 'audioinput')
        // BUG-190: Chromium lists the default input three times ("Default -",
        // "Communications -", and the device itself); show it once.
        const list = dedupeInputDevices(
          ins.map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `Microphone ${i + 1}`
          }))
        )
        setMics(list)

        // Labels are empty until mic permission is granted; resolving against a
        // list of unnamed devices would "repair" the choice onto the wrong one.
        const labelsKnown = list.some((d) => d.label && !/^Microphone \d+$/.test(d.label))
        if (list.length > 0 && labelsKnown) {
          const resolution = resolveMic(
            {
              deviceId: getSelectedMicId(),
              label: getSelectedMicLabel(),
              explicit: hasExplicitMicChoice()
            },
            list,
            { preferCallRise: preferRef.current }
          )
          setMicResolution(resolution)
          if (resolution.status === 'repaired' || resolution.status === 'auto-callrise') {
            setSelectedMic(resolution.deviceId, resolution.label)
            setSel(resolution.deviceId)
          } else if (resolution.status === 'ok' && !getSelectedMicLabel()) {
            // Choice made before labels were stored — backfill it so the next
            // driver reinstall is recoverable.
            setSelectedMic(resolution.deviceId, resolution.label)
          }
        }

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

  // Keep every mounted instance in step. Whichever one's enumeration resolves
  // first performs the repair; without this the others keep showing the old
  // device while a different one is actually being recorded.
  useEffect(() => subscribeSelectedMic((id) => setSel(id)), [])

  // A driver (re)install changes the device list, so re-resolve when the
  // caller starts preferring the denoising mic.
  useEffect(() => {
    if (preferCallRiseMic) refresh()
  }, [preferCallRiseMic, refresh])

  const chooseMic = useCallback((id: string): void => {
    setSel(id)
    setMicResolution(null)
    // Store the LABEL alongside the id so this choice survives a driver
    // reinstall that renumbers device ids.
    // explicit=true: this is a real user action, so it must never be
    // auto-overridden later - including when they pick "System default",
    // which stores an empty id and is otherwise indistinguishable from
    // "never chosen".
    setSelectedMic(id, '', true)
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const match = devices.find((d) => d.kind === 'audioinput' && d.deviceId === id)
        if (match?.label) setSelectedMic(id, match.label, true)
      })
      .catch(() => {
        /* the id is still stored; only the label backfill was best-effort */
      })
  }, [])

  return { mics, outputLabel, selectedMicId, chooseMic, refresh, micResolution }
}
