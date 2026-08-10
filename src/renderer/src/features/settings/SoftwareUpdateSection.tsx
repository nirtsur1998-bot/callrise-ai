import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SettingRow } from './SettingRow'
import { useAppSettings } from './useAppSettings'
import type { UpdateStatus } from '../../../../main/updater'

/** One line explaining the current updater state — never the raw status
 *  object, and never silent about a 'disabled'/'refused'/'error' state, per
 *  the updater's own "an error is a refusal, never carry on and hope"
 *  design (src/main/updater/policy.ts). */
function statusLine(status: UpdateStatus | null, version: string | null): string {
  if (!status) return version ? `Version ${version}` : 'Checking version…'
  switch (status.state) {
    case 'disabled':
      return 'Automatic updates are off for this build.'
    case 'idle':
      return version ? `Version ${version} — up to date` : "You're up to date"
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${status.version} is available`
    case 'refused':
      // Genuinely rare — the updater's own validation rejected the offered
      // update (see policy.ts's validateUpdate). Worth surfacing plainly
      // rather than as a generic "something went wrong".
      return `An update was offered but rejected: ${status.reason}`
    case 'downloaded':
      return `Version ${status.version} downloaded — restart to install`
    case 'error':
      return `Update check failed: ${status.message}`
    default:
      return status satisfies never
  }
}

export function SoftwareUpdateSection(): React.JSX.Element {
  const [version, setVersion] = useState<string | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const mountedRef = useRef(true)
  const { settings, update: updateSettings } = useAppSettings()

  useEffect(() => {
    mountedRef.current = true
    void window.api.app.getVersion().then((v) => {
      if (mountedRef.current) setVersion(v)
    })
    void window.api.updater.status().then((s) => {
      if (mountedRef.current) setStatus(s)
    })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const runAction = useCallback(
    async (action: () => Promise<UpdateStatus>) => {
      setBusy(true)
      try {
        const next = await action()
        if (mountedRef.current) setStatus(next)
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    []
  )

  const check = useCallback(() => runAction(() => window.api.updater.check()), [runAction])
  const download = useCallback(() => runAction(() => window.api.updater.download()), [runAction])
  const install = useCallback(() => {
    // No status update on success — quitAndInstall closes the app, so
    // there's nothing left to reflect it in.
    void window.api.updater.install()
  }, [])

  if (status?.state === 'disabled') {
    // Deliberately no button at all — matches the updater's own "no feed
    // configured means no network activity, not a failed check" contract
    // (src/main/updater/index.ts). A "Check for updates" button here would
    // imply a check that can never actually happen.
    return (
      <Card className="mb-5">
        <SettingRow
          title="Software update"
          description={statusLine(status, version)}
          control={<span className="text-xs text-faint">Off</span>}
        />
      </Card>
    )
  }

  const action = (): React.JSX.Element => {
    if (status?.state === 'downloaded') {
      return (
        <Button size="sm" variant="primary" icon={RotateCw} onClick={install}>
          Restart &amp; install
        </Button>
      )
    }
    if (status?.state === 'available') {
      return (
        <Button
          size="sm"
          variant="primary"
          icon={busy ? Loader2 : Download}
          disabled={busy}
          onClick={() => void download()}
        >
          {busy ? 'Downloading…' : 'Download update'}
        </Button>
      )
    }
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={busy ? Loader2 : RefreshCw}
        disabled={busy}
        onClick={() => void check()}
      >
        {busy ? 'Checking…' : 'Check for updates'}
      </Button>
    )
  }

  return (
    <Card className="mb-5">
      <SettingRow title="Software update" description={statusLine(status, version)} control={action()} />
      <div className="mt-3 border-t border-line-soft pt-3">
        <SettingRow
          title="Update automatically"
          description="Download and install new versions on their own — no clicks needed. Off by default; the Check/Download/Restart buttons above still work either way."
          control={
            <ToggleSwitch
              checked={settings.autoUpdateEnabled}
              onChange={(v) => void updateSettings({ autoUpdateEnabled: v })}
              label="Update automatically"
            />
          }
        />
      </div>
    </Card>
  )
}
