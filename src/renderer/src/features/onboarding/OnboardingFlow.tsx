import { useState } from 'react'
import { AudioLines, ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Button } from '@renderer/components/Button'
import { useOnboarding } from './useOnboarding'
import { Welcome } from './steps/Welcome'
import { AboutYou } from './steps/AboutYou'
import { WhatYouSell } from './steps/WhatYouSell'
import { RecordingConsent } from './steps/RecordingConsent'
import { CoachingCues } from './steps/CoachingCues'
import { ApiKey } from './steps/ApiKey'
import { Done } from './steps/Done'

/** Where to land the user once onboarding closes. */
export type OnboardingExit = 'home' | 'live-calls'

const secondaryBtn =
  'rounded-lg px-3.5 py-2.5 text-sm font-medium text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'

export function OnboardingFlow({
  onComplete
}: {
  onComplete: (exit: OnboardingExit) => void
}): React.JSX.Element {
  const o = useOnboarding()
  const [busy, setBusy] = useState(false)

  const done = async (exit: OnboardingExit): Promise<void> => {
    setBusy(true)
    await o.finish()
    onComplete(exit)
  }

  const skip = async (): Promise<void> => {
    setBusy(true)
    await o.skip()
    onComplete('home')
  }

  // Fraction of the numbered journey completed, for the top progress bar.
  const progress =
    o.step === 'welcome' ? 0 : o.step === 'done' ? 1 : (o.stepNumber ?? 0) / (o.totalNumbered + 1)

  return (
    <div className="relative flex h-screen w-screen items-center justify-center bg-canvas px-6 text-ink">
      {/* Draggable strip so the window can still be moved. */}
      <div className="drag absolute inset-x-0 top-0 h-10" />

      <div className="w-full max-w-md">
        {/* Brand + progress */}
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand shadow-sm">
            <AudioLines className="h-4.5 w-4.5 text-white" strokeWidth={2.25} />
          </div>
          <div className="flex-1">
            <div
              role="progressbar"
              aria-valuenow={Math.round(progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1 w-full overflow-hidden rounded-full bg-elevated"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
          {o.stepNumber !== null && (
            <span className="shrink-0 text-[12px] font-medium text-faint tabular-nums">
              Step {o.stepNumber} of {o.totalNumbered}
            </span>
          )}
        </div>

        <div className="rounded-2xl border border-line-soft bg-surface p-7">
          <div key={o.step} className="animate-view">
            {o.step === 'welcome' && <Welcome onStart={o.next} onSkip={skip} busy={busy} />}
            {o.step === 'about' && <AboutYou o={o} />}
            {o.step === 'sell' && <WhatYouSell o={o} />}
            {o.step === 'recording' && <RecordingConsent o={o} />}
            {o.step === 'cues' && <CoachingCues o={o} />}
            {o.step === 'apiKey' && <ApiKey />}
            {o.step === 'done' && (
              <Done
                o={o}
                busy={busy}
                onStartCall={() => done('live-calls')}
                onExplore={() => done('home')}
              />
            )}
          </div>

          {/* Shared footer for the middle steps (welcome + done own their own actions). */}
          {o.step !== 'welcome' && o.step !== 'done' && (
            <div className="mt-7 flex items-center justify-between border-t border-line-soft pt-5">
              <button
                type="button"
                onClick={o.back}
                className={cn(secondaryBtn, 'flex items-center gap-1.5')}
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <div className="flex items-center gap-1">
                <button type="button" onClick={skip} disabled={busy} className={secondaryBtn}>
                  Skip for now
                </button>
                <Button onClick={o.next} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
