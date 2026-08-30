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
      const [keys, calls, google, outlook] = await Promise.all([
        window.api.aiKeys.getStatus().catch(() => null),
        window.api.calls.list().catch(() => []),
        window.api.google.getStatus().catch(() => null),
        window.api.outlook.getStatus().catch(() => null)
      ])
      if (cancelled) return

      const aiKeyNames = [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GROQ_API_KEY',
        'OPENROUTER_API_KEY',
        'GOOGLE_AI_API_KEY',
        'NVIDIA_API_KEY',
        'CEREBRAS_API_KEY',
        'MISTRAL_API_KEY'
      ] as const

      setState({
        hasTranscriptionKey: keys?.DEEPGRAM_API_KEY?.configured === true,
        hasAiKey: aiKeyNames.some((n) => keys?.[n]?.configured === true),
        callCount: calls.length,
        coachedCount: calls.filter((c) => c.hasCoaching).length,
        calendarConnected: google?.connected === true || outlook?.connected === true,
        salesBrainOn: settings.salesBrain.enabled,
        // NOT WIRED TODAY, and the reason is worth stating rather than
        // hiding, because the capability above it is real and tested.
        //
        // BUG-136 means Google sign-in currently fails for everyone (the
        // OAuth client is unpublished), and a step telling someone to
        // "connect your calendar" while that is true sends them to fail. The
        // blocked state exists for exactly that.
        //
        // But THE APP CANNOT CURRENTLY DETECT IT. `google.getStatus()`
        // returns only { connected, configured, mode }; the failure reason
        // exists solely as the return value of `connect()`, which the
        // checklist must not call — that opens a browser window nobody asked
        // for. Inventing a detection here would be a guess dressed as a
        // status, so this stays null and the step reads as an ordinary todo.
        //
        // What would wire it: persist the last connect failure in main and
        // surface it on getStatus(). Small, and out of scope mid-checklist —
        // logged rather than smuggled in.
        calendarBlockedReason: null
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
