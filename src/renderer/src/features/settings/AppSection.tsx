import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { isMac, isWindows } from '@renderer/lib/platform'
import { clearOnboardingComplete } from '@renderer/features/onboarding/prefs'
import { SettingRow } from './SettingRow'
import { SoftwareUpdateSection } from './SoftwareUpdateSection'

export function AppSection(): React.JSX.Element {
  const [launchAtLogin, setLaunchAtLoginState] = useState(false)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

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
      <SoftwareUpdateSection />
    </>
  )
}
