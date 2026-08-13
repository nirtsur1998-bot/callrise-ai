import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { isMac, isWindows } from '@renderer/lib/platform'
import { clearOnboardingComplete } from '@renderer/features/onboarding/prefs'
import { useAppSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'
import { SoftwareUpdateSection } from './SoftwareUpdateSection'

/** M26 Phase 5 — one plain number input per lane, styled to match this
 *  file's other controls. LIVE is deliberately not offered here at all —
 *  it stays fixed at unbounded, never user-adjustable (a live call must
 *  never wait behind anything). */
function LaneConcurrencyInput({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        min={1}
        max={10}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(Math.max(1, Math.min(10, Math.round(n))))
        }}
        className="w-16 rounded-lg border border-line bg-canvas px-2 py-1 text-right text-sm tabular-nums"
      />
    </label>
  )
}

export function AppSection(): React.JSX.Element {
  const [launchAtLogin, setLaunchAtLoginState] = useState(false)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)
  const { settings, update } = useAppSettings()

  useEffect(() => {
    mountedRef.current = true
    void window.api.app
      .getLaunchAtLogin()
      .then((v) => {
        if (mountedRef.current) setLaunchAtLoginState(v)
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setLaunchAtLogin = useCallback(async (value: boolean) => {
    const next = await window.api.app.setLaunchAtLogin(value)
    if (mountedRef.current) setLaunchAtLoginState(next)
  }, [])

  const osName = isMac ? 'macOS' : isWindows ? 'Windows' : 'your computer'

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Launch at login"
          description={`Start CallRise AI automatically when you log into ${osName}. Only takes effect in the installed app, not while running in development.`}
          control={
            <ToggleSwitch
              checked={launchAtLogin}
              disabled={loading}
              onChange={(v) => void setLaunchAtLogin(v)}
              label="Launch at login"
            />
          }
        />
      </Card>
      <Card className="mb-5">
        <SettingRow
          title="Replay setup"
          description="Walk through the welcome flow again — your name, recording preferences, and coaching cues are pre-filled with what's already saved."
          control={
            <button
              type="button"
              onClick={() => {
                clearOnboardingComplete()
                window.location.reload()
              }}
              className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              Replay setup
            </button>
          }
        />
      </Card>
      <Card className="mb-5">
        <SettingRow
          title="Error log"
          description="If something goes wrong, this file has the details — open it and attach it when reporting a problem."
          control={
            <button
              type="button"
              onClick={() => void window.api.app.openLogsFolder()}
              className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              Open log file
            </button>
          }
        />
      </Card>
      <Card className="mb-5">
        <SettingRow
          title="Background job notifications"
          description="Show a desktop notification when a background job (a summary, a sync, a scan) finishes while this window isn't focused. The in-app indicator always shows regardless."
          control={
            <ToggleSwitch
              checked={settings.jobNotifications.nativeEnabled}
              onChange={(v) => void update({ jobNotifications: { nativeEnabled: v } })}
              label="Desktop notifications for background jobs"
            />
          }
        />
      </Card>
      <Card className="mb-5">
        <p className="text-sm font-medium">Background job concurrency</p>
        <p className="mt-1 text-[12px] text-faint">
          How many jobs of each kind can run at once. Higher numbers finish a backlog faster but
          use more CPU/network/AI-provider quota at the same time. Live-call work is never limited
          by this — it always runs immediately, regardless of anything else queued.
        </p>
        <div className="mt-3 divide-y divide-line-soft">
          <LaneConcurrencyInput
            label="Interactive (summaries, notes, drafts you're waiting on)"
            value={settings.jobConcurrency.interactive}
            onChange={(v) => void update({ jobConcurrency: { interactive: v } })}
          />
          <LaneConcurrencyInput
            label="Batch (scans, imports)"
            value={settings.jobConcurrency.batch}
            onChange={(v) => void update({ jobConcurrency: { batch: v } })}
          />
          <LaneConcurrencyInput
            label="Maintenance (backup, Sales Brain housekeeping)"
            value={settings.jobConcurrency.maintenance}
            onChange={(v) => void update({ jobConcurrency: { maintenance: v } })}
          />
        </div>
      </Card>
      <SoftwareUpdateSection />
    </>
  )
}
