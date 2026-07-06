import { cn } from '@renderer/lib/cn'

interface ToggleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** Accessible name — required since the switch has no visible text of its own. */
  label: string
}

/** A small on/off switch. The app has no existing Switch primitive (booleans
 *  are usually rendered as pill buttons); Settings needs enough of these that
 *  one shared, accessible control is worth it. */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label
}: ToggleSwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        // Flexbox + padding + justify, not absolute-position + manual pixel
        // translate — that math (fixed px knob offset vs rem-based track
        // width) is exactly what let the knob overflow the track before.
        'flex h-6 w-11 shrink-0 items-center rounded-full border p-0.5 transition disabled:cursor-default disabled:opacity-50',
        checked ? 'justify-end border-accent bg-accent' : 'justify-start border-line bg-elevated'
      )}
    >
      <span className="h-5 w-5 shrink-0 rounded-full bg-white shadow" />
    </button>
  )
}
