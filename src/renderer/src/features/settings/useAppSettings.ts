import { useCallback, useEffect, useRef, useState } from 'react'

export type AppSettings = Awaited<ReturnType<typeof window.api.settings.get>>
export type AppSettingsPatch = Parameters<typeof window.api.settings.update>[0]
export type SummaryLanguage = AppSettings['summaryLanguage']
export type CrmSettings = AppSettings['crm']
export type AiModelAssignments = AppSettings['aiModelAssignments']
export type Coach2Settings = AppSettings['coach2']
export type ContactIntelligenceSettings = AppSettings['contactIntelligence']
export type SpeakerIdSettings = AppSettings['speakerId']

// The safe default (matches main's own fallback) shown until the real value
// loads — never more permissive than what loadAppSettings() would return.
const DEFAULT_SETTINGS: AppSettings = {
  allowOtherPartyRecording: true,
  alwaysRecordOtherParty: false,
  personalization: { name: '', role: '', pronoun: '', about: '' },
  summaryLanguage: 'auto',
  syncScope: {
    transcripts: false,
    attachments: false,
    knowledgeBase: false,
    settingsPersonalization: false,
    contacts: false,
    salesBrain: false
  },
  settingsUpdatedAt: new Date(0).toISOString(),
  googleCalendarConnected: false,
  outlookCalendarConnected: false,
  crm: {
    calendarMatchEnabled: true,
    matchSensitivity: 'normal',
    autoLinkUnambiguous: false,
    defaultCountry: '',
    autoNumberCid: false,
    cidPrefix: 'CUST-',
    cidNextNumber: 1,
    staleFollowUpEnabled: true,
    staleAfterDays: 14,
    autoGenerateNotes: false,
    noteGeneratorEnabled: false
  },
  objectionMining: { enabled: false },
  detection: { enabled: false, capturePolicy: { autoCapturePolicy: 'mic-only', appOverrides: {} } },
  speakerId: { enabled: true, allowSelfIntroExtraction: false, voiceProfileMatching: false },
  aiProvider: 'anthropic',
  aiModelAssignments: {
    'coaching-cue': { chain: [] },
    summary: { chain: [] },
    scorecard: { chain: [] },
    tasks: { chain: [] },
    other: { chain: [] },
    'prep-brief': { chain: [] },
    'deal-tier1': { chain: [] },
    'deal-tier2': { chain: [] },
    'coaching-chat': { chain: [] },
    'memory-extract': { chain: [] }
  },
  autoUpdateEnabled: true,
  autoUpdateMigratedToDefaultOn: true,
  autoUpdateNoticePending: false,
  coach2: { enabled: false, methodology: 'blended' },
  contactIntelligence: { mode: 'off' },
  salesBrain: { enabled: false },
  dealIntelligence: {
    enabled: false,
    sensitivity: 'balanced',
    enabledTypes: { risk: true, opportunity: true, tactical: true },
    frequency: 'balanced'
  },
  liveCues: { enabled: true, sensitivity: 'low' },
  jobConcurrency: { interactive: 2, batch: 1, maintenance: 1 },
  jobNotifications: { nativeEnabled: true }
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
