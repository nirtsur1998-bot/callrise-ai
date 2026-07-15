import type { OnboardingState } from '../useOnboarding'
import { StepHeader, fieldInput } from './StepHeader'

const MAX_ABOUT = 1500

/** Step 2: the free-text "about" → settings.personalization.about, which the
 *  app already folds into every summary and coaching request. */
export function WhatYouSell({ o }: { o: OnboardingState }): React.JSX.Element {
  return (
    <div>
      <StepHeader
        title="What you sell"
        subtitle="A sentence or two. This gets added to every summary and coaching request."
      />
      <textarea
        value={o.about}
        onChange={(e) => o.setAbout(e.target.value)}
        maxLength={MAX_ABOUT}
        autoFocus
        rows={5}
        placeholder="e.g. I sell mid-market SaaS, usually 3–6 month cycles, and I lead with ROI over feature lists."
        className={`${fieldInput} resize-y`}
      />
      <p className="mt-2 text-[11px] text-faint">
        Optional — but it’s the single biggest thing that makes the AI sound like it knows your
        world.
      </p>
    </div>
  )
}
