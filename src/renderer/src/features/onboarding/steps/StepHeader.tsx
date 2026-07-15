/** Shared title + subtitle block at the top of each onboarding step. */
export function StepHeader({
  title,
  subtitle
}: {
  title: string
  subtitle: string
}): React.JSX.Element {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{subtitle}</p>
    </div>
  )
}

export const fieldInput =
  'w-full rounded-lg border border-line-soft bg-canvas px-3 py-2 text-sm text-ink outline-none transition placeholder:text-faint focus:border-line'
