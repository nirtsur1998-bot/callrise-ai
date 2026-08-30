import { Card } from '@renderer/components/Card'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { useTheme } from './useTheme'
import type { ThemeMode } from './theme'
import { useDesignPreview } from './useDesignPreview'

const OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' }
]

export function AppearanceSection(): React.JSX.Element {
  const { mode, setMode } = useTheme()
  const { enabled: newDesign, setEnabled: setNewDesign } = useDesignPreview()

  return (
    <>
      <Card className="mb-5">
        <p className="mb-3 text-sm font-medium">Theme</p>
        <SegmentedControl options={OPTIONS} value={mode} onChange={setMode} />
        <p className="mt-2 text-[11px] text-faint">
          &ldquo;System&rdquo; follows your computer&rsquo;s dark/light setting.
        </p>
      </Card>

      {/* M31 — ONE switch for the whole redesign.
          This was four separate toggles, one per stage (navigation, calendar,
          look, Settings layout). The founder's call, and it is hard to argue
          with: "four toggles for one redesign is itself a discoverability
          problem, which would be ironic."

          One switch also means ONE failure mode. With four, "off" had sixteen
          possible states and fifteen of them were half-reverted — a new
          sidebar with the old palette, a new Settings layout inside the old
          nav. Now there is exactly one thing to be true or false. */}
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">New design (preview)</p>
            <p className="mt-1 text-[12px] text-muted">
              CallRise&rsquo;s own colours and typeface, a sidebar of 7 sections instead of 12, a
              Settings list grouped around what you&rsquo;re trying to do, and a calendar that
              opens on the week. Nothing is removed and nothing about your data changes &mdash;
              every screen, shortcut and saved link still works either way. Turn it off to go
              straight back to the app exactly as it ships today.
            </p>
          </div>
          <ToggleSwitch checked={newDesign} onChange={setNewDesign} label="New design (preview)" />
        </div>
      </Card>
    </>
  )
}
