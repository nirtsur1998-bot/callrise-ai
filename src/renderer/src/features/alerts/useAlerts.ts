import { useCallback, useEffect, useRef, useState } from 'react'

// Derived straight from the preload bridge so these can never drift from
// what the main process actually returns (same pattern as useContacts.ts).
export type NotificationChannel = Awaited<ReturnType<typeof window.api.alerts.channels.list>>[number]
export type AlertRule = Awaited<ReturnType<typeof window.api.alerts.rules.list>>[number]
export type UserAlertSettings = NonNullable<Awaited<ReturnType<typeof window.api.alerts.settings.get>>>
export type AlertTriggerType = Parameters<typeof window.api.alerts.rules.create>[0]['triggerType']

export interface UseAlertsResult {
  channels: NotificationChannel[]
  rules: AlertRule[]
  settings: UserAlertSettings | null
  loading: boolean
  reload: () => Promise<void>
  createRule: (input: {
    triggerType: AlertTriggerType
    leadTimeMinutes?: number
    params?: Record<string, unknown>
    channelIds?: string[]
  }) => Promise<void>
  updateRule: (
    ruleId: string,
    patch: Partial<{
      enabled: boolean
      leadTimeMinutes: number
      params: Record<string, unknown>
      channelIds: string[]
    }>
  ) => Promise<void>
  deleteRule: (ruleId: string) => Promise<void>
  deleteChannel: (channelId: string) => Promise<void>
  updateSettings: (patch: Partial<UserAlertSettings>) => Promise<void>
}

/** Loads channels/rules/settings and exposes mutators that refetch afterward
 *  — the data set here is small (a handful of rules/channels per user), so a
 *  full reload after each mutation is simpler and safer than hand-patching
 *  local state and risking it drifting from what Supabase actually stored. */
export function useAlerts(): UseAlertsResult {
  const [channels, setChannels] = useState<NotificationChannel[]>([])
  const [rules, setRules] = useState<AlertRule[]>([])
  const [settings, setSettings] = useState<UserAlertSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // State is only set after the await (and only while mounted) — no setState
  // call sits synchronously in the effect's own call stack, so this is safe
  // to fire straight from an effect without extra render churn.
  const reload = useCallback(async () => {
    try {
      const [c, r, s] = await Promise.all([
        window.api.alerts.channels.list(),
        window.api.alerts.rules.list(),
        window.api.alerts.settings.get()
      ])
      if (!mountedRef.current) return
      setChannels(c)
      setRules(r)
      setSettings(s)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const createRule: UseAlertsResult['createRule'] = useCallback(
    async (input) => {
      await window.api.alerts.rules.create(input)
      await reload()
    },
    [reload]
  )

  const updateRule: UseAlertsResult['updateRule'] = useCallback(
    async (ruleId, patch) => {
      await window.api.alerts.rules.update(ruleId, patch)
      await reload()
    },
    [reload]
  )

  const deleteRule = useCallback(
    async (ruleId: string) => {
      await window.api.alerts.rules.delete(ruleId)
      await reload()
    },
    [reload]
  )

  const deleteChannel = useCallback(
    async (channelId: string) => {
      await window.api.alerts.channels.delete(channelId)
      await reload()
    },
    [reload]
  )

  const updateSettings = useCallback(
    async (patch: Partial<UserAlertSettings>) => {
      await window.api.alerts.settings.update(patch)
      await reload()
    },
    [reload]
  )

  return { channels, rules, settings, loading, reload, createRule, updateRule, deleteRule, deleteChannel, updateSettings }
}
