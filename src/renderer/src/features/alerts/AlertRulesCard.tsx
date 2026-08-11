import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { fieldClass } from '@renderer/components/field'
import type { AlertRule, AlertTriggerType, NotificationChannel } from './useAlerts'

const LEAD_TIME_OPTIONS = [1, 5, 10, 15, 30, 60] as const

const TRIGGER_LABELS: Record<AlertTriggerType, string> = {
  meeting_starting: 'Meeting starting',
  task_due: 'Task due',
  deal_cold: 'Deal gone cold',
  no_next_step: 'No next step booked'
}

const NEEDS_LEAD_TIME: Record<AlertTriggerType, boolean> = {
  meeting_starting: true,
  task_due: true,
  deal_cold: false,
  no_next_step: false
}

interface AlertRulesCardProps {
  rules: AlertRule[]
  channels: NotificationChannel[]
  onCreate: (input: {
    triggerType: AlertTriggerType
    leadTimeMinutes?: number
    params?: Record<string, unknown>
    channelIds?: string[]
  }) => Promise<void>
  onUpdate: (
    ruleId: string,
    patch: Partial<{ enabled: boolean; leadTimeMinutes: number; params: Record<string, unknown>; channelIds: string[] }>
  ) => Promise<void>
  onDelete: (ruleId: string) => Promise<void>
}

function channelLabel(c: NotificationChannel): string {
  if (c.type === 'desktop') return 'Desktop (while running)'
  return c.label || c.address || c.type
}

export function AlertRulesCard({
  rules,
  channels,
  onCreate,
  onUpdate,
  onDelete
}: AlertRulesCardProps): React.JSX.Element {
  const [newTrigger, setNewTrigger] = useState<AlertTriggerType>('meeting_starting')
  const [newLeadTime, setNewLeadTime] = useState<number>(10)
  const [newChannelIds, setNewChannelIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const availableChannels = channels.filter((c) => c.type === 'desktop' || c.verified_at)

  const toggleNewChannel = (id: string): void => {
    setNewChannelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const addRule = async (): Promise<void> => {
    setBusy(true)
    try {
      await onCreate({
        triggerType: newTrigger,
        leadTimeMinutes: NEEDS_LEAD_TIME[newTrigger] ? newLeadTime : undefined,
        channelIds: newChannelIds
      })
      setNewChannelIds([])
    } finally {
      setBusy(false)
    }
  }

  const ruleChannelIds = (rule: AlertRule): string[] =>
    (rule.alert_rule_channels ?? []).map((rc) => rc.channel_id)

  const toggleRuleChannel = async (rule: AlertRule, channelId: string): Promise<void> => {
    const current = ruleChannelIds(rule)
    const next = current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]
    await onUpdate(rule.id, { channelIds: next })
  }

  return (
    <Card className="mb-5">
      <p className="text-sm font-medium">Alert rules</p>
      <p className="mt-1 mb-4 text-[12px] text-muted">
        A rule with two lead times (e.g. 15 min and 1 min before a meeting) needs two separate rows
        below — add the trigger twice with different lead times.
      </p>

      <div className="space-y-3">
        {rules.map((rule) => (
          <div key={rule.id} className="rounded-lg border border-line-soft p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ToggleSwitch
                  checked={rule.enabled}
                  onChange={(v) => void onUpdate(rule.id, { enabled: v })}
                  label={`Enable ${TRIGGER_LABELS[rule.trigger_type]}`}
                />
                <span className="text-[13px] font-medium">{TRIGGER_LABELS[rule.trigger_type]}</span>
                {rule.lead_time_minutes !== null && (
                  <span className="text-[12px] text-muted">— {rule.lead_time_minutes} min before</span>
                )}
              </div>
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => void onDelete(rule.id)}>
                Delete
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-3">
              {availableChannels.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    checked={ruleChannelIds(rule).includes(c.id)}
                    onChange={() => void toggleRuleChannel(rule, c.id)}
                  />
                  {channelLabel(c)}
                </label>
              ))}
              {availableChannels.length === 0 && (
                <span className="text-[12px] text-faint">No channels yet — add one above.</span>
              )}
            </div>
          </div>
        ))}
        {rules.length === 0 && <p className="text-[12px] text-faint">No alert rules yet.</p>}
      </div>

      <div className="mt-4 rounded-lg border border-dashed border-line-soft p-3">
        <p className="mb-2 text-[13px] font-medium">Add a rule</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
              Trigger
            </span>
            <select
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value as AlertTriggerType)}
              className={fieldClass}
            >
              {(Object.keys(TRIGGER_LABELS) as AlertTriggerType[]).map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABELS[t]}
                </option>
              ))}
            </select>
          </label>

          {NEEDS_LEAD_TIME[newTrigger] && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
                Lead time
              </span>
              <select
                value={newLeadTime}
                onChange={(e) => setNewLeadTime(Number(e.target.value))}
                className={fieldClass}
              >
                {LEAD_TIME_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex flex-wrap gap-3">
            {availableChannels.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={newChannelIds.includes(c.id)}
                  onChange={() => toggleNewChannel(c.id)}
                />
                {channelLabel(c)}
              </label>
            ))}
          </div>

          <Button size="sm" icon={Plus} disabled={busy} onClick={() => void addRule()}>
            Add rule
          </Button>
        </div>
      </div>
    </Card>
  )
}
