import { useState } from 'react'
import { Card } from '@renderer/components/Card'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { fieldClass } from '@renderer/components/field'
import type { UserAlertSettings } from './useAlerts'

interface QuietHoursCardProps {
  settings: UserAlertSettings | null
  onUpdate: (patch: Partial<UserAlertSettings>) => Promise<void>
}

const QUIET_BEHAVIOR_OPTIONS = [
  { id: 'hold' as const, label: 'Hold until quiet hours end' },
  { id: 'drop' as const, label: 'Drop entirely' }
]

const RATE_LIMIT_OPTIONS = [
  { id: 'drop' as const, label: 'Drop' },
  { id: 'queue' as const, label: 'Queue' },
  { id: 'coalesce' as const, label: 'Combine' }
]

/** Quiet hours, rate limiting, and the deal_cold digest schedule — all read
 *  from user_alert_settings. meeting_starting/task_due always bypass quiet
 *  hours server-side (see alert-dispatcher) since a late reminder for
 *  something that already happened is worse than an early one; this card
 *  only controls the two non-time-critical triggers. */
export function QuietHoursCard({ settings, onUpdate }: QuietHoursCardProps): React.JSX.Element {
  const [timezone, setTimezone] = useState(settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)

  if (!settings) {
    return (
      <Card className="mb-5">
        <p className="text-[12px] text-faint">Sign in to configure alert timing.</p>
      </Card>
    )
  }

  return (
    <Card className="mb-5">
      <p className="text-sm font-medium">Timing & limits</p>
      <p className="mt-1 mb-4 text-[12px] text-muted">
        Meeting and task reminders are time-critical and always ignore quiet hours — a meeting
        reminder that arrives after the meeting is worse than none at all.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            Timezone
          </span>
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            onBlur={() => void onUpdate({ timezone })}
            placeholder="America/New_York"
            className={fieldClass}
          />
        </label>

        <div />

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            Quiet hours start
          </span>
          <input
            type="time"
            value={settings.quiet_hours_start ?? ''}
            onChange={(e) => void onUpdate({ quiet_hours_start: e.target.value || null })}
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            Quiet hours end
          </span>
          <input
            type="time"
            value={settings.quiet_hours_end ?? ''}
            onChange={(e) => void onUpdate({ quiet_hours_end: e.target.value || null })}
            className={fieldClass}
          />
        </label>

        <div className="sm:col-span-2">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            When a non-critical alert falls in quiet hours
          </span>
          <SegmentedControl
            options={QUIET_BEHAVIOR_OPTIONS}
            value={settings.quiet_hours_behavior}
            onChange={(v) => void onUpdate({ quiet_hours_behavior: v })}
          />
        </div>

        <div className="sm:col-span-2">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            When too many alerts fire in an hour
          </span>
          <SegmentedControl
            options={RATE_LIMIT_OPTIONS}
            value={settings.rate_limit_behavior}
            onChange={(v) => void onUpdate({ rate_limit_behavior: v })}
          />
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            Max alerts per hour
          </span>
          <input
            type="number"
            min={1}
            max={200}
            value={settings.max_alerts_per_hour}
            onChange={(e) => void onUpdate({ max_alerts_per_hour: Number(e.target.value) })}
            className={fieldClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            &ldquo;Deal gone cold&rdquo; after (days)
          </span>
          <input
            type="number"
            min={1}
            max={90}
            value={settings.deal_cold_days}
            onChange={(e) => void onUpdate({ deal_cold_days: Number(e.target.value) })}
            className={fieldClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
            Cold-deal digest hour (0–23, your timezone)
          </span>
          <input
            type="number"
            min={0}
            max={23}
            value={settings.deal_cold_digest_hour}
            onChange={(e) => void onUpdate({ deal_cold_digest_hour: Number(e.target.value) })}
            className={fieldClass}
          />
        </label>
      </div>
    </Card>
  )
}
