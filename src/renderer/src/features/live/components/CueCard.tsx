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
import type { CueKind, LiveCue } from '../useLiveCues'

interface CueStyle {
  icon: LucideIcon
  label: string
  ring: string
  iconBg: string
  iconText: string
  /** Solid bar color for the countdown bar (matches iconBg's hue). */
  bar: string
}

const META: Record<CueKind, CueStyle> = {
  objection: {
    icon: AlertTriangle,
    label: 'Objection',
    ring: 'border-warning/40',
    iconBg: 'bg-warning-soft',
    iconText: 'text-warning',
    bar: 'bg-warning'
  },
  discovery: {
    icon: Search,
    label: 'Discovery',
    ring: 'border-accent/40',
    iconBg: 'bg-accent-soft',
    iconText: 'text-accent',
    bar: 'bg-accent'
  },
  'next-question': {
    icon: MessageCircleQuestion,
    label: 'Ask',
    ring: 'border-accent/40',
    iconBg: 'bg-accent-soft',
    iconText: 'text-accent',
    bar: 'bg-accent'
  },
  'buying-signal': {
    icon: TrendingUp,
    label: 'Buying signal',
    ring: 'border-positive/40',
    iconBg: 'bg-positive-soft',
    iconText: 'text-positive',
    bar: 'bg-positive'
  },
  pace: {
    icon: Gauge,
    label: 'Pace',
    ring: 'border-line',
    iconBg: 'bg-elevated',
    iconText: 'text-muted',
    bar: 'bg-muted'
  }
}

// Mirrors useLiveCues' AUTO_DISMISS_MS so the countdown bar visually matches
// when the cue actually disappears (kept in sync by hand — that file isn't
// touched by this styling pass).
const AUTO_DISMISS_MS = 10_000

/**
 * A single, glanceable, non-modal coaching cue pinned to the bottom-right of
 * the live screen. Dismissible; gently fades in.
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

  const meta = META[cue.kind]
  const Icon = meta.icon

  return (
    <div
      role="status"
      className={cn(
        'absolute bottom-4 right-4 z-40 w-64 overflow-hidden rounded-xl border bg-surface/95 p-3 shadow-2xl backdrop-blur transition-all duration-300',
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
