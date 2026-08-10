import { Skeleton } from '@renderer/components/Skeleton'
import { useAlerts } from './useAlerts'
import { ChannelsCard } from './ChannelsCard'
import { AlertRulesCard } from './AlertRulesCard'
import { QuietHoursCard } from './QuietHoursCard'

/** Settings → Alerts: channels, rules, and timing — the whole Task 1 UI. */
export function AlertsSection(): React.JSX.Element {
  const { channels, rules, settings, loading, reload, createRule, updateRule, deleteRule, deleteChannel, updateSettings } =
    useAlerts()

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <>
      <ChannelsCard channels={channels} onDelete={deleteChannel} onReload={reload} />
      <AlertRulesCard
        rules={rules}
        channels={channels}
        onCreate={createRule}
        onUpdate={updateRule}
        onDelete={deleteRule}
      />
      <QuietHoursCard settings={settings} onUpdate={updateSettings} />
    </>
  )
}
