import type { ReactNode } from 'react'

interface SettingRowProps {
  title: string
  description?: string
  control: ReactNode
}

/** A label + description on the left, a control (toggle, buttons, …) on the
 *  right — the recurring layout for a single setting inside a Card. */
export function SettingRow({ title, description, control }: SettingRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 text-[12px] text-muted">{description}</p>}
      </div>
      {control}
    </div>
  )
}
