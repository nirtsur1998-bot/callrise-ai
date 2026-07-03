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
import type { CueKind, LiveCue } from '../useLiveCues'

interface CueStyle {
  icon: LucideIcon
  label: string
  ring: string
  iconBg: string
  iconText: string
}

const META: Record<CueKind, CueStyle> = {
  objection: {
    icon: AlertTriangle,
    label: 'Objection',
    ring: 'border-amber-500/40',
    iconBg: 'bg-amber-500/15',
    iconText: 'text-amber-300'
  },
  discovery: {
    icon: Search,
    label: 'Discovery',
    ring: 'border-accent/40',
    iconBg: 'bg-accent-soft',
    iconText: 'text-accent'
  },
  'next-question': {
    icon: MessageCircleQuestion,
    label: 'Ask',
    ring: 'border-sky-500/40',
    iconBg: 'bg-sky-500/15',
    iconText: 'text-sky-300'
  },
  'buying-signal': {
    icon: TrendingUp,
    label: 'Buying signal',
    ring: 'border-emerald-500/40',
    iconBg: 'bg-emerald-500/15',
    iconText: 'text-emerald-300'
  },
  pace: {
    icon: Gauge,
    label: 'Pace',
    ring: 'border-slate-500/40',
    iconBg: 'bg-slate-500/15',
    iconText: 'text-slate-300'
  }
}

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
        'absolute bottom-4 right-4 z-40 w-64 rounded-xl border bg-surface/95 p-3 shadow-2xl backdrop-blur transition-all duration-300',
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
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-elevated hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
