import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import {
  SALES_METHODOLOGIES,
  METHODOLOGY_LABEL,
  type SalesMethodology
} from '@renderer/features/coaching/types'
import { useAppSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'

/**
 * M23 Workstream A — the master switch for the benchmark engine, Skill
 * Graph, methodology-aware scoring, and the Focus Skill loop. Off by
 * default: a coached call is exactly the pre-M23 six-dimension scorecard
 * until this is turned on.
 */
export function Coach2Section(): React.JSX.Element {
  const { settings, update } = useAppSettings()
  const enabled = settings.coach2.enabled
  const methodology = settings.coach2.methodology

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Coach 2.0 — skill-building"
          description="Adds research-backed benchmarks, an 8-skill progress graph that trends across your calls, and a single Focus Skill the coach has you deliberately practice each call. Your existing scorecard keeps working exactly as before either way."
          control={
            <ToggleSwitch
              checked={enabled}
              onChange={(next) => void update({ coach2: { enabled: next } })}
              label="Coach 2.0 — skill-building"
            />
          }
        />
      </Card>

      <Card className="mb-5">
        <h3 className="mb-1 text-sm font-semibold">Sales methodology</h3>
        <p className="mb-4 text-[12px] text-muted">
          "Blended" lets the coach pick whichever framework best fits each call (today's default
          behavior). Choosing one specifically scores every call's "Methodology adherence" skill
          against that framework's key elements — and the coach's advice adapts to match.
        </p>
        <SegmentedControl
          options={SALES_METHODOLOGIES.map((m) => ({ id: m, label: METHODOLOGY_LABEL[m] }))}
          value={methodology}
          disabled={!enabled}
          onChange={(next: SalesMethodology) => void update({ coach2: { methodology: next } })}
          className="flex-wrap"
        />
        {!enabled && (
          <p className="mt-3 text-[11px] text-faint">Turn on Coach 2.0 above to choose a methodology.</p>
        )}
      </Card>
    </>
  )
}
