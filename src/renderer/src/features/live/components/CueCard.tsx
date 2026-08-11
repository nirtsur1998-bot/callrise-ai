import { useEffect, useState } from 'react'
import {
  MessageCircleQuestion,
  Gauge,
  Search,
  AlertTriangle,
  TrendingUp,
  X,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { IconButton } from '@renderer/components/IconButton'
import { AUTO_DISMISS_MS, type CueKind, type LiveCue } from '../useLiveCues'

interface CueStyle {
  icon: LucideIcon
  label: string
  ring: string
  iconBg: string
  iconText: string
  /** Solid bar color for the countdown bar (matches iconBg's hue). */
  bar: string
}

// Partial on purpose: this component renders the INTERRUPT channel, and most
// kinds (battlecards, model suggestions) can only ever reach the side rail.
// A kind with no entry here falls back to the neutral treatment rather than
// crashing — a missing style is not worth losing the cue over.
const NEUTRAL: CueStyle = {
  icon: Gauge,
  label: 'Cue',
  ring: 'ring-line',
  iconBg: 'bg-elevated',
  iconText: 'text-muted',
  bar: 'bg-muted'
}

const META: Partial<Record<CueKind, CueStyle>> = {
  objection: {
    icon: AlertTriangle,
    label: 'Objection',
    ring: 'ring-warning/45',
    iconBg: 'bg-warning-soft',
    iconText: 'text-warning',
    bar: 'bg-warning'
  },
  discovery: {
    icon: Search,
    label: 'Discovery',
    ring: 'ring-accent/45',
    iconBg: 'bg-accent-soft',
    iconText: 'text-accent',
    bar: 'bg-accent'
  },
  'next-question': {
    icon: MessageCircleQuestion,
    label: 'Ask',
    ring: 'ring-accent/45',
    iconBg: 'bg-accent-soft',
    iconText: 'text-accent',
    bar: 'bg-accent'
  },
  'buying-signal': {
    icon: TrendingUp,
    label: 'Buying signal',
    ring: 'ring-positive/45',
    iconBg: 'bg-positive-soft',
    iconText: 'text-positive',
    bar: 'bg-positive'
  },
  pace: {
    icon: Gauge,
    label: 'Pace',
    ring: 'ring-line',
    iconBg: 'bg-elevated',
    iconText: 'text-muted',
    bar: 'bg-muted'
  }
}

/**
 * A single, glanceable, non-modal coaching cue — the INTERRUPT tier (§4.3).
 *
 * Positioning belongs to the stack that owns it, not to this card: the cue and
 * the suggestion rail share one right-hand column so they cannot collide,
 * which is a guarantee two independently-positioned absolute elements can only
 * ever approximate.
 *
 * Visually this is the loud sibling of the same glass material the rail uses —
 * same system, more weight — so "this one matters" reads instantly without the
 * live screen looking like two different apps.
 */
export function CueCard({
  cue,
  onDismiss
}: {
  cue: LiveCue
  onDismiss: () => void
}): React.JSX.Element {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const meta = META[cue.kind] ?? NEUTRAL
  const Icon = meta.icon

  return (
    <div
      role="status"
      className={cn(
        'glass-hud pointer-events-auto relative w-full overflow-hidden rounded-2xl p-3 ring-1 ring-inset transition-all duration-300',
        meta.ring,
        shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', meta.iconBg)}>
          <Icon className={cn('h-4 w-4', meta.iconText)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            {meta.label}
          </p>
          <p className="text-sm font-medium text-ink">{cue.text}</p>
        </div>
        <IconButton icon={X} onClick={onDismiss} label="Dismiss" />
      </div>
      <div
        className={cn('cue-countdown absolute inset-x-0 bottom-0 h-0.5 origin-left', meta.bar)}
        style={{ animationDuration: `${AUTO_DISMISS_MS}ms` }}
      />
    </div>
  )
}
