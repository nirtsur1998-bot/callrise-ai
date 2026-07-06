import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { CountrySelect } from '@renderer/components/CountrySelect'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { cn } from '@renderer/lib/cn'
import { clearAllDismissedMatches } from '@renderer/features/contacts/calendarMatch'
import { useAppSettings, type CrmSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'

type MatchSensitivity = CrmSettings['matchSensitivity']

const SENSITIVITIES: { id: MatchSensitivity; label: string }[] = [
  { id: 'tight', label: 'Tight (5 min)' },
  { id: 'normal', label: 'Normal (15 min)' },
  { id: 'loose', label: 'Loose (30 min)' }
]

export function CrmSection(): React.JSX.Element {
  const { settings, loading, update } = useAppSettings()
  const crm = settings.crm
  const [cleared, setCleared] = useState(false)

  const setCrm = (patch: Partial<CrmSettings>): void => {
    void update({ crm: patch })
  }

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Calendar-match suggestions"
          description="When a saved call happens around the same time as a calendar invite, offer to link it to that attendee's contact. Always confirmed — never links or creates anything on its own unless auto-link (below) is also on."
          control={
            <ToggleSwitch
              checked={crm.calendarMatchEnabled}
              disabled={loading}
              onChange={(v) => setCrm({ calendarMatchEnabled: v })}
              label="Calendar-match suggestions"
            />
          }
        />

        <div
          className={cn(
            'mt-4 border-t border-line-soft pt-4',
            !crm.calendarMatchEnabled && 'opacity-50'
          )}
        >
          <p className="mb-2 text-[13px] font-medium">Match sensitivity</p>
          <div className="inline-flex rounded-lg border border-line p-0.5">
            {SENSITIVITIES.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={!crm.calendarMatchEnabled || loading}
                onClick={() => setCrm({ matchSensitivity: s.id })}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[13px] font-medium transition disabled:cursor-default',
                  crm.matchSensitivity === s.id
                    ? 'bg-accent-soft text-ink'
                    : 'text-muted hover:text-ink'
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-faint">
            How close a calendar event must be to the call&rsquo;s actual time to count as a match.
          </p>
        </div>

        <div
          className={cn(
            'mt-4 border-t border-line-soft pt-4',
            !crm.calendarMatchEnabled && 'opacity-50'
          )}
        >
          <SettingRow
            title="Auto-link unambiguous matches"
            description="When exactly one calendar match points to a contact you already have, link it automatically instead of asking — you'll still see a notice, and can undo it. Never auto-creates a new contact."
            control={
              <ToggleSwitch
                checked={crm.autoLinkUnambiguous}
                disabled={!crm.calendarMatchEnabled || loading}
                onChange={(v) => setCrm({ autoLinkUnambiguous: v })}
                label="Auto-link unambiguous matches"
              />
            }
          />
        </div>

        <div className="mt-4 border-t border-line-soft pt-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Dismissed suggestions</p>
              <p className="mt-1 text-[12px] text-muted">
                Bring back any calendar-match suggestions you dismissed with &ldquo;Not now&rdquo;.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                clearAllDismissedMatches()
                setCleared(true)
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Show again
            </button>
          </div>
          {cleared && <p className="mt-2 text-[12px] text-emerald-300">Cleared.</p>}
        </div>
      </Card>

      <Card className="mb-5">
        <p className="mb-1 text-sm font-medium">Default country for new contacts</p>
        <p className="mb-3 text-[12px] text-muted">
          Pre-fills the country field — still editable per contact.
        </p>
        <CountrySelect
          value={crm.defaultCountry || undefined}
          onChange={(code) => setCrm({ defaultCountry: code ?? '' })}
          placeholder="No default"
        />
      </Card>

      <Card className="mb-5">
        <SettingRow
          title="Auto-numbered Customer No."
          description="Automatically fill in a sequential customer number for new contacts that don't have one — still editable per contact."
          control={
            <ToggleSwitch
              checked={crm.autoNumberCid}
              disabled={loading}
              onChange={(v) => setCrm({ autoNumberCid: v })}
              label="Auto-numbered Customer No."
            />
          }
        />
        <div
          className={cn('mt-4 border-t border-line-soft pt-4', !crm.autoNumberCid && 'opacity-50')}
        >
          <label className="mb-1.5 block text-[13px] font-medium text-muted">Prefix</label>
          <input
            value={crm.cidPrefix}
            disabled={!crm.autoNumberCid || loading}
            onChange={(e) => setCrm({ cidPrefix: e.target.value })}
            onBlur={(e) => setCrm({ cidPrefix: e.target.value.trim() || 'CUST-' })}
            placeholder="CUST-"
            className="w-full max-w-[200px] rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm outline-none transition focus:border-line disabled:cursor-default"
          />
          <p className="mt-2 text-[11px] text-faint">
            Next number: {crm.cidPrefix}
            {crm.cidNextNumber}
          </p>
        </div>
      </Card>
    </>
  )
}
