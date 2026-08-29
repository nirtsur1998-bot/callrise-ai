import { Card } from '@renderer/components/Card'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { useTheme } from './useTheme'
import type { ThemeMode } from './theme'
import { useNavigationPreview } from '@renderer/features/navigation/useNavigationPreview'

const OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' }
]

export function AppearanceSection(): React.JSX.Element {
  const { mode, setMode } = useTheme()
  const { enabled: navPreview, setEnabled: setNavPreview } = useNavigationPreview()

  return (
    <>
      <Card className="mb-5">
        <p className="mb-3 text-sm font-medium">Theme</p>
        <SegmentedControl options={OPTIONS} value={mode} onChange={setMode} />
        <p className="mt-2 text-[11px] text-faint">
          &ldquo;System&rdquo; follows your computer&rsquo;s dark/light setting.
        </p>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Try the new navigation (preview)</p>
            <p className="mt-1 text-[12px] text-muted">
              A reworked sidebar — 7 sections instead of 12, with Live/Past Calls, CRM/Tasks/
              Calendar, and Coaching/Analytics/Team each grouped under one item. Nothing is
              removed: every existing screen is still there, just regrouped, and every keyboard
              shortcut, deep link, and saved link keeps working. Turn this off any time to go
              straight back to today&rsquo;s layout — nothing about your data changes either way.
            </p>
          </div>
          <ToggleSwitch
            checked={navPreview}
            onChange={setNavPreview}
            label="Try the new navigation (preview)"
          />
        </div>
      </Card>
    </>
  )
}
