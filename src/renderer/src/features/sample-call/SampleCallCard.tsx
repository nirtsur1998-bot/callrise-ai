import { useState } from 'react'
import { FlaskConical, ArrowRight, X } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import type { NavId } from '@renderer/features/navigation/nav-items'
import { isSampleCallSeen, markSampleCallSeen } from './sampleCall'

/**
 * M36 Stage 1 — Home's offer of the sample call. Shown until the sample has
 * been opened once (or dismissed), then gone for good: it is a door for
 * someone with nothing set up, not a permanent fixture. NOT a fifth
 * checklist step — the checklist is capped at four by the founder's
 * evidence-backed decision (activationSteps.ts) and a test asserts the count.
 */
export function SampleCallCard({ onNavigate }: { onNavigate: (id: NavId) => void }): React.JSX.Element | null {
  const [hidden, setHidden] = useState(() => isSampleCallSeen())
  if (hidden) return null
  return (
    <div
      data-testid="sample-call-card"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3"
    >
      <FlaskConical className="h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">See CallRise on a sample call first</p>
        <p className="text-[12px] text-muted">
          A six-minute invented call with its live cues and coaching — no keys, no microphone, nothing saved.
        </p>
      </div>
      <Button size="sm" onClick={() => onNavigate('sample-call')}>
        Open the sample <ArrowRight className="h-3.5 w-3.5" />
      </Button>
      <IconButton
        icon={X}
        label="Dismiss — you can still start a real call from Calls"
        onClick={() => {
          markSampleCallSeen()
          setHidden(true)
        }}
      />
    </div>
  )
}
