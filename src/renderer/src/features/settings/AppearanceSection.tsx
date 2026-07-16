import { Card } from '@renderer/components/Card'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { useTheme } from './useTheme'
import type { ThemeMode } from './theme'

const OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'System' }
]

export function AppearanceSection(): React.JSX.Element {
  const { mode, setMode } = useTheme()

  return (
    <Card className="mb-5">
      <p className="mb-3 text-sm font-medium">Theme</p>
      <SegmentedControl options={OPTIONS} value={mode} onChange={setMode} />
      <p className="mt-2 text-[11px] text-faint">
        &ldquo;System&rdquo; follows your computer&rsquo;s dark/light setting.
      </p>
    </Card>
  )
}
