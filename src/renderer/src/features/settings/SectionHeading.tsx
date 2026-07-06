import type { LucideIcon } from 'lucide-react'

interface SectionHeadingProps {
  icon: LucideIcon
  title: string
  description?: string
}

/** A small uppercase label above a group of Settings cards. */
export function SectionHeading({
  icon: Icon,
  title,
  description
}: SectionHeadingProps): React.JSX.Element {
  return (
    <div className="mt-8 mb-3 first:mt-0">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-faint" />
        <h3 className="text-[12px] font-semibold tracking-wide text-faint uppercase">{title}</h3>
      </div>
      {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
    </div>
  )
}
