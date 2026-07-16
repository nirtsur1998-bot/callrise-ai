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
