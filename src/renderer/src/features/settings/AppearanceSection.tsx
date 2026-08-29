import { Card } from '@renderer/components/Card'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { useTheme } from './useTheme'
import type { ThemeMode } from './theme'
import { useNavigationPreview } from '@renderer/features/navigation/useNavigationPreview'
import { useCalendarPreview } from '@renderer/features/calendar/useCalendarPreview'
import { useIdentityPreview } from './useIdentityPreview'

const OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' }
]

export function AppearanceSection(): React.JSX.Element {
  const { mode, setMode } = useTheme()
  const { enabled: navPreview, setEnabled: setNavPreview } = useNavigationPreview()
  const { enabled: calPreview, setEnabled: setCalPreview } = useCalendarPreview()
  const { enabled: identityPreview, setEnabled: setIdentityPreview } = useIdentityPreview()

  return (
    <>
      <Card className="mb-5">
        <p className="mb-3 text-sm font-medium">Theme</p>
        <SegmentedControl options={OPTIONS} value={mode} onChange={setMode} />
        <p className="mt-2 text-[11px] text-faint">
          &ldquo;System&rdquo; follows your computer&rsquo;s dark/light setting.
        </p>
      </Card>

      <Card className="mb-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Try the new look (preview)</p>
            <p className="mt-1 text-[12px] text-muted">
              CallRise&rsquo;s own colours — warm amber and graphite — instead of the indigo-on-blue
              every AI tool ships with. It also fixes cards and dividers being nearly invisible in
              the light theme. This changes colours only: nothing moves, nothing is removed, and
              nothing about your data changes. Turn it off to see exactly what the app looked like
              before.
            </p>
          </div>
          <ToggleSwitch
            checked={identityPreview}
            onChange={setIdentityPreview}
            label="Try the new look (preview)"
          />
        </div>
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

      <Card className="mt-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Try the new calendar (preview)</p>
            <p className="mt-1 text-[12px] text-muted">
              Opens on the week instead of the month (and remembers whichever view you last used),
              and replaces the two large Google/Outlook connection cards with a single compact line
              — the full connection controls are still one click away, and also in Settings →
              Calendar. Nothing about your events or sync changes. Turn this off any time to go
              straight back to today&rsquo;s calendar.
            </p>
          </div>
          <ToggleSwitch
            checked={calPreview}
            onChange={setCalPreview}
            label="Try the new calendar (preview)"
          />
        </div>
      </Card>
    </>
  )
}
