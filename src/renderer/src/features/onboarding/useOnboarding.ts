import { useEffect, useMemo, useState } from 'react'
import type { ConsentJurisdiction } from '@renderer/features/calls/types'
import type { Sensitivity } from '@renderer/features/live/useLiveCues'
import { saveDefaultJurisdiction } from '@renderer/features/consent/prefs'
import { useAppSettings, type AppSettings } from '@renderer/features/settings/useAppSettings'
import { markOnboardingComplete } from './prefs'
import type { MicOutcome } from '@renderer/features/audio/micOutcome'

type Pronoun = AppSettings['personalization']['pronoun']

// M26 Phase 4.5.2 — the cue prefs used to live in renderer-only localStorage
// (see live/useCueSettings.ts's history); onboarding wrote them directly so
// it didn't need to mount the live-call hook. Now that main owns them
// (app-settings.ts's liveCues field), onboarding persists them the same way
// it already persists personalization/recording — through this same
// useAppSettings() `update()` call, in the same persist() batch below.

export type StepId =
  | 'welcome'
  | 'about'
  | 'sell'
  | 'recording'
  | 'mic'
  | 'cues'
  | 'apiKey'
  | 'done'

/** Ordered list of steps; drives the progress bar and Back/Continue. */
export const STEPS: StepId[] = [
  'welcome',
  'about',
  'sell',
  'recording',
  'mic',
  'cues',
  'apiKey',
  'done'
]

/** Steps that count toward the "Step N of M" marker (welcome/done are chromeless). */
const NUMBERED: StepId[] = ['about', 'sell', 'recording', 'mic', 'cues', 'apiKey']

export interface OnboardingState {
  // personalization drafts
  name: string
  setName: (v: string) => void
  role: string
  setRole: (v: string) => void
  pronoun: Pronoun
  setPronoun: (v: Pronoun) => void
  about: string
  setAbout: (v: string) => void

  // recording + consent
  recordBothSides: boolean
  setRecordBothSides: (v: boolean) => void
  jurisdiction: ConsentJurisdiction
  setJurisdiction: (v: ConsentJurisdiction) => void

  // microphone step — what the request actually came back with (null = not asked yet)
  micOutcome: MicOutcome | null
  setMicOutcome: (v: MicOutcome | null) => void

  // live coaching cues
  cuesEnabled: boolean
  setCuesEnabled: (v: boolean) => void
  sensitivity: Sensitivity
  setSensitivity: (v: Sensitivity) => void

  // navigation
  step: StepId
  stepNumber: number | null
  totalNumbered: number
  isFirst: boolean
  isLast: boolean
  next: () => void
  back: () => void

  /** True until saved settings have loaded (drafts pre-filled). */
  loading: boolean
  /** Persist everything into the real stores and mark onboarding done. */
  finish: () => Promise<void>
  /** Skip the rest — persist what's entered so far, then mark done. */
  skip: () => Promise<void>
}

export function useOnboarding(): OnboardingState {
  const { settings, loading, update } = useAppSettings()

  const [index, setIndex] = useState(0)

  // Personalization drafts — pre-filled from saved settings once they load, so a
  // re-run of onboarding shows what's already there rather than blanking it.
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [pronoun, setPronoun] = useState<Pronoun>('')
  const [about, setAbout] = useState('')
  const [recordBothSides, setRecordBothSides] = useState(false)
  const [jurisdiction, setJurisdiction] = useState<ConsentJurisdiction>('two-party')
  const [cuesEnabled, setCuesEnabled] = useState(true)
  const [sensitivity, setSensitivity] = useState<Sensitivity>('low')
  const [micOutcome, setMicOutcome] = useState<MicOutcome | null>(null)
  const [prefilled, setPrefilled] = useState(false)

  useEffect(() => {
    if (loading || prefilled) return
    const p = settings.personalization
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time prefill of drafts when saved settings arrive
    setName(p.name)
    setRole(p.role)
    setPronoun(p.pronoun)
    setAbout(p.about)
    setRecordBothSides(settings.allowOtherPartyRecording)
    setPrefilled(true)
  }, [loading, prefilled, settings])

  const step = STEPS[index]
  const stepNumber = NUMBERED.includes(step) ? NUMBERED.indexOf(step) + 1 : null

  const next = (): void => setIndex((i) => Math.min(i + 1, STEPS.length - 1))
  const back = (): void => setIndex((i) => Math.max(i - 1, 0))

  // Persist every collected value into the stores the app already reads.
  const persist = async (): Promise<void> => {
    await update({
      personalization: { name: name.trim(), role: role.trim(), pronoun, about: about.trim() },
      allowOtherPartyRecording: recordBothSides,
      liveCues: { enabled: cuesEnabled, sensitivity }
    })
    if (recordBothSides) saveDefaultJurisdiction(jurisdiction)
  }

  const finish = async (): Promise<void> => {
    try {
      await persist()
    } finally {
      markOnboardingComplete()
    }
  }

  // Skip persists whatever's been entered so far (never worse than defaults),
  // then marks done so it doesn't reappear.
  const skip = finish

  return useMemo(
    () => ({
      name,
      setName,
      role,
      setRole,
      pronoun,
      setPronoun,
      about,
      setAbout,
      recordBothSides,
      setRecordBothSides,
      jurisdiction,
      setJurisdiction,
      micOutcome,
      setMicOutcome,
      cuesEnabled,
      setCuesEnabled,
      sensitivity,
      setSensitivity,
      step,
      stepNumber,
      totalNumbered: NUMBERED.length,
      isFirst: index === 0,
      isLast: index === STEPS.length - 1,
      next,
      back,
      loading,
      finish,
      skip
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      name,
      role,
      pronoun,
      about,
      recordBothSides,
      jurisdiction,
      micOutcome,
      cuesEnabled,
      sensitivity,
      index,
      loading
    ]
  )
}
