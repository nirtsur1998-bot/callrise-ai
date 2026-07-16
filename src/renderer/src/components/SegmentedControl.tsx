import { cn } from '@renderer/lib/cn'

interface SegmentedControlProps<T extends string> {
  options: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  disabled?: boolean
  className?: string
}

/** A pill segmented toggle — the Settings sensitivity/theme pickers and the
 *  Tasks/Deals filters, unified into one control with a consistent selected
 *  treatment (accent-soft fill) and press feedback. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  className
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div className={cn('inline-flex rounded-lg border border-line p-0.5', className)}>
      {options.map((opt) => {
        const selected = opt.id === value
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(opt.id)}
            className={cn(
              'press rounded-md px-3 py-1.5 text-[13px] font-medium transition disabled:cursor-default disabled:opacity-50',
              selected ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
