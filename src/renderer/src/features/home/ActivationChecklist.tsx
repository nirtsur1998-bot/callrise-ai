import { useEffect, useState } from 'react'
import { Check, ChevronRight, CircleDashed, Info, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Card } from '@renderer/components/Card'
import { openSettingsAt } from '@renderer/features/settings/settingsNav'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import {
  buildActivationSteps,
  activationProgress,
  type ActivationState,
  type ActivationStep
} from './activationSteps'

const DISMISS_KEY = 'salesos.home.activationDismissed'

/**
 * M31 Stage 3 — the activation checklist on Home.
 *
 * Rules that shaped it, from the founder:
 *   • for someone with NOTHING set up
 *   • every step answers "why would I bother"
 *   • it knows what is already done, and a done step says what you now HAVE
 *   • a step that cannot be completed says so instead of offering a dead action
 *
 * All of that lives in activationSteps.ts, where it is tested. This file
 * fetches the state and draws the result.
 *
 * Not a tour, deliberately (audit §5.3 item 7): nothing is modal, nothing
 * blocks, and it can be dismissed. It hides itself once complete rather than
 * lingering as a wall of ticks — a finished checklist is clutter.
 */
export function ActivationChecklist(): React.JSX.Element | null {
  const { settings } = useAppSettings()
  const [state, setState] = useState<ActivationState | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Every lookup is independently optional. A checklist that fails to
      // render because one IPC call rejected would be worse than one that is
      // briefly wrong, so each falls back to "not done" — which shows the
      // step rather than hiding it, the safer direction for a nudge.
      // google/outlook were fetched here for the calendar step, which was
      // cut on 2026-08-30. Removed with it rather than left running: two
      // IPC round trips on every Home render, feeding a field nothing reads,
      // is the kind of cost that survives forever because it is invisible.
      const [keys, calls] = await Promise.all([
        window.api.aiKeys.getStatus().catch(() => null),
        window.api.calls.list().catch(() => [])
      ])
      if (cancelled) return

      setState({
        hasTranscriptionKey: keys?.DEEPGRAM_API_KEY?.configured === true,
        // NO LIST HERE, DELIBERATELY. This used to enumerate the eight text-AI
        // key names, which made it a hand-maintained copy of a list that lives
        // in main — and it broke the moment M31 added a ninth and tenth: the
        // founder pasted a real Hugging Face key and this step stayed unticked,
        // because the name was not in the local array. Asking "is anything
        // other than Deepgram configured?" derives the answer from whatever
        // main actually returns, so it cannot drift again. Adding a provider
        // now requires no edit to this file at all.
        // The '_API_KEY' suffix is load-bearing, not cosmetic: the vault also
        // holds CLOUDFLARE_ACCOUNT_ID, which is half of a base URL rather than
        // a credential. Counting it would tick this step for someone who had
        // pasted an account id and no key — the same false-done this whole
        // checklist exists to avoid. Still no list: the rule reads the naming
        // convention, and provider-lockstep.test.ts pins the one exception.
        hasAiKey: Object.entries(keys ?? {}).some(
          ([name, status]) =>
            name.endsWith('_API_KEY') &&
            name !== 'DEEPGRAM_API_KEY' &&
            status?.configured === true
        ),
        callCount: calls.length,
        coachedCount: calls.filter((c) => c.hasCoaching).length,
        salesBrainOn: settings.salesBrain.enabled
      })
    })()
    return () => {
      cancelled = true
    }
  }, [settings.salesBrain.enabled])

  if (dismissed || !state) return null

  const steps = buildActivationSteps(state)
  const { done, total, complete } = activationProgress(steps)
  // A finished checklist is clutter. It disappears rather than sitting there
  // as a wall of ticks congratulating you.
  if (complete) return null

  const dismiss = (): void => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, 'true')
    } catch {
      /* best-effort */
    }
  }

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">Get CallRise working</p>
          <p className="mt-0.5 text-[12px] text-muted">
            {done} of {total} done — each one turns on something specific.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide this checklist"
          className="shrink-0 rounded-md p-1 text-faint transition hover:bg-elevated hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ul>
    </Card>
  )
}

function StepRow({ step }: { step: ActivationStep }): React.JSX.Element {
  const isDone = step.status === 'done'
  const isBlocked = step.status === 'blocked'
  // A done step has nothing to do, and a blocked one has nothing that WOULD
  // work — neither is clickable, so neither pretends to be.
  const actionable = !isDone && !isBlocked && Boolean(step.settingsPage)

  const body = (
    <>
      <span className="mt-0.5 shrink-0">
        {isDone ? (
          <Check className="h-4 w-4 text-positive" />
        ) : isBlocked ? (
          <Info className="h-4 w-4 text-warning" />
        ) : (
          <CircleDashed className="h-4 w-4 text-faint" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[13px] font-medium', isDone ? 'text-muted' : 'text-ink')}>
          {step.title}
        </span>
        {/* The done state says what you HAVE; the todo state says why to
            bother; the blocked state says why you cannot. Three different
            sentences, never the same one with a tick next to it. */}
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
          {isDone ? step.doneLabel : isBlocked ? step.blockedReason : step.why}
        </span>
      </span>
      {actionable && <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-faint" />}
    </>
  )

  const shared = 'flex w-full items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left'

  return (
    <li>
      {actionable ? (
        <button
          type="button"
          onClick={() => step.settingsPage && openSettingsAt(step.settingsPage)}
          className={cn(shared, 'transition hover:bg-elevated')}
        >
          {body}
        </button>
      ) : (
        <div className={shared}>{body}</div>
      )}
    </li>
  )
}
