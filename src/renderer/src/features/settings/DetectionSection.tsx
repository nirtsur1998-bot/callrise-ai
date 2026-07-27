import { useEffect, useState } from 'react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { cn } from '@renderer/lib/cn'
import { SettingRow } from './SettingRow'
import { useAppSettings, type AppSettingsPatch } from './useAppSettings'

type CapturePolicyValue = 'full' | 'mic-only' | 'ask'
type AppOverride = 'full' | 'mic-only' | 'ask' | 'never' | 'default'

const POLICY_OPTIONS: { id: CapturePolicyValue; label: string }[] = [
  { id: 'full', label: 'Capture everything' },
  { id: 'mic-only', label: 'My side, wait for consent' },
  { id: 'ask', label: 'Ask me first' }
]

const OVERRIDE_OPTIONS: { id: AppOverride; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'full', label: 'Full' },
  { id: 'mic-only', label: 'Mic-only' },
  { id: 'ask', label: 'Ask' },
  { id: 'never', label: 'Never' }
]

export function DetectionSection(): React.JSX.Element {
  const { settings, loading, update } = useAppSettings()
  const detection = settings.detection
  const [knownApps, setKnownApps] = useState<{ appId: string; displayName: string }[]>([])

  useEffect(() => {
    void window.api.detection.getKnownApps().then(setKnownApps)
  }, [])

  const patchDetection = (patch: AppSettingsPatch['detection']): void => {
    void update({ detection: patch })
  }

  const setPolicy = (autoCapturePolicy: CapturePolicyValue): void => {
    patchDetection({ capturePolicy: { autoCapturePolicy } })
  }

  const setOverride = (appId: string, value: AppOverride): void => {
    const next = { ...detection.capturePolicy.appOverrides }
    if (value === 'default') delete next[appId]
    else next[appId] = value
    patchDetection({ capturePolicy: { appOverrides: next } })
  }

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Ambient call detection"
          description="Notice on its own when you're on a call in a known app (Zoom, Teams, Google Meet, Slack huddles, WhatsApp, …) and start capturing without you having to click Start. Purely a heuristic — it never records anything the recording & consent rules below wouldn't already allow."
          control={
            <ToggleSwitch
              checked={detection.enabled}
              disabled={loading}
              onChange={(v) => patchDetection({ enabled: v })}
              label="Ambient call detection"
            />
          }
        />

        <div
          className={cn('mt-4 border-t border-line-soft pt-4', !detection.enabled && 'opacity-50')}
        >
          <p className="mb-2 text-[13px] font-medium">When a call is detected</p>
          <SegmentedControl
            options={POLICY_OPTIONS}
            value={detection.capturePolicy.autoCapturePolicy}
            onChange={setPolicy}
            disabled={!detection.enabled || loading}
          />
          <p className="mt-2 text-[11px] text-faint">
            &ldquo;Capture everything&rdquo; still only unlocks the other party&rsquo;s audio once
            they&rsquo;ve actually consented on the call — this only changes what happens the
            instant a call is noticed.
          </p>
        </div>
      </Card>

      <Card className={cn('mb-5', !detection.enabled && 'opacity-50')}>
        <p className="text-sm font-medium">Per-app overrides</p>
        <p className="mt-1 mb-3 text-[12px] text-muted">
          Override the policy above for specific apps — e.g. always ask for Discord, never capture
          Slack huddles.
        </p>
        <div className="space-y-2">
          {knownApps.map((app) => {
            const current: AppOverride =
              detection.capturePolicy.appOverrides[app.appId] ?? 'default'
            return (
              <div key={app.appId} className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-ink">{app.displayName}</span>
                <SegmentedControl
                  options={OVERRIDE_OPTIONS}
                  value={current}
                  onChange={(v) => setOverride(app.appId, v)}
                  disabled={!detection.enabled || loading}
                />
              </div>
            )
          })}
        </div>
      </Card>
    </>
  )
}
