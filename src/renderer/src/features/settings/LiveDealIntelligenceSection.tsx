import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import {
  useDealIntelligenceSettings,
  type AnalysisFrequency
} from '@renderer/features/deal-intelligence/useDealIntelligenceSettings'
import type { NudgeType, Sensitivity } from '@renderer/features/deal-intelligence/nudgeEngine'
import { NUDGE_META } from '@renderer/features/deal-intelligence/ui/meta'
import { SettingRow } from './SettingRow'

const SENSITIVITIES: Sensitivity[] = ['quiet', 'balanced', 'aggressive']
const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  quiet: 'Quiet',
  balanced: 'Balanced',
  aggressive: 'Aggressive'
}
const SENSITIVITY_OPTIONS = SENSITIVITIES.map((s) => ({ id: s, label: SENSITIVITY_LABEL[s] }))

const NUDGE_TYPES: NudgeType[] = ['risk', 'opportunity', 'tactical']
const NUDGE_TYPE_DESCRIPTION: Record<NudgeType, string> = {
  risk: 'The deal is going sideways — stalling, disengagement, an unresolved objection.',
  opportunity: 'A buying signal or an opening to advance the deal.',
  tactical: 'Something specific and actionable right now, neither a clear risk nor opportunity.'
}

const FREQUENCIES: AnalysisFrequency[] = ['frequent', 'balanced', 'infrequent']
const FREQUENCY_LABEL: Record<AnalysisFrequency, string> = {
  frequent: 'Frequent',
  balanced: 'Balanced',
  infrequent: 'Infrequent'
}
const FREQUENCY_OPTIONS = FREQUENCIES.map((f) => ({ id: f, label: FREQUENCY_LABEL[f] }))

export function LiveDealIntelligenceSection(): React.JSX.Element {
  const {
    enabled,
    setEnabled,
    sensitivity,
    setSensitivity,
    enabledTypes,
    setTypeEnabled,
    frequency,
    setFrequency
  } = useDealIntelligenceSettings()

  return (
    <Card className="mb-5">
      <SettingRow
        title="Live Deal Intelligence (Beta)"
        description="Watches the live transcript against this deal's context and surfaces rare, high-value nudges when the deal is going sideways or a buying signal appears. Off by default — this makes real AI calls during the call, on top of live coaching cues."
        control={
          <ToggleSwitch
            checked={enabled}
            onChange={setEnabled}
            label="Enable Live Deal Intelligence"
          />
        }
      />

      <div className={cn('mt-4 border-t border-line-soft pt-4', !enabled && 'opacity-50')}>
        <p className="mb-2 text-[13px] font-medium">Sensitivity</p>
        <SegmentedControl
          options={SENSITIVITY_OPTIONS}
          value={sensitivity}
          onChange={setSensitivity}
          disabled={!enabled}
        />
        <p className="mt-2 text-[11px] text-faint">
          Quiet shows the fewest, highest-confidence nudges. Aggressive shows more, sooner, at a
          lower confidence bar. Every setting still hard-caps how often nudges can appear — this is
          never meant to interrupt often.
        </p>
      </div>

      <div className={cn('mt-4 border-t border-line-soft pt-4', !enabled && 'opacity-50')}>
        <p className="mb-2 text-[13px] font-medium">Nudge types</p>
        <div className="space-y-2">
          {NUDGE_TYPES.map((type) => {
            const meta = NUDGE_META[type]
            const Icon = meta.icon
            return (
              <div
                key={type}
                className="flex items-center justify-between gap-3 rounded-lg border border-line-soft px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Icon className={cn('size-4 shrink-0', meta.text)} />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">{meta.label}</p>
                    <p className="truncate text-[11px] text-faint">
                      {NUDGE_TYPE_DESCRIPTION[type]}
                    </p>
                  </div>
                </div>
                <ToggleSwitch
                  checked={enabledTypes[type]}
                  onChange={(on) => setTypeEnabled(type, on)}
                  disabled={!enabled}
                  label={`Show ${meta.label} nudges`}
                />
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-[11px] text-faint">
          At least one type must stay on — this is a filter on what Live Deal Intelligence shows,
          not a second way to turn the whole feature off.
        </p>
      </div>

      <div className={cn('mt-4 border-t border-line-soft pt-4', !enabled && 'opacity-50')}>
        <p className="mb-2 text-[13px] font-medium">Analysis frequency</p>
        <SegmentedControl
          options={FREQUENCY_OPTIONS}
          value={frequency}
          onChange={setFrequency}
          disabled={!enabled}
        />
        <p className="mt-2 text-[11px] text-faint">
          How often this re-checks the call. Frequent catches things sooner but makes more AI calls;
          Infrequent checks less often to save on cost/latency.
        </p>
      </div>
    </Card>
  )
}
