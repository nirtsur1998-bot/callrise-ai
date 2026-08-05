import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { isMac, isWindows } from '@renderer/lib/platform'
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
      <SoftwareUpdateSection />
    </>
  )
}
