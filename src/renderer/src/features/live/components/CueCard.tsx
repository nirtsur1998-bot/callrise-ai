import { useEffect, useState, type CSSProperties } from 'react'
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
  /** The 3px left rule, in the kind's colour — the one place the card says
   *  what kind of cue it is without a coloured surface. */
  rule: string
  iconBg: string
  iconText: string
  /** The countdown ring's colour, as a CSS value (matches the rule's hue). */
  ringColor: string
}

// Partial on purpose: this component renders the INTERRUPT channel, and most
// kinds (battlecards, model suggestions) can only ever reach the side rail.
// A kind with no entry here falls back to the neutral treatment rather than
// crashing — a missing style is not worth losing the cue over.
const NEUTRAL: CueStyle = {
  icon: Gauge,
  label: 'Cue',
  rule: 'border-l-line-strong',
  iconBg: 'bg-elevated',
  iconText: 'text-muted',
  ringColor: 'var(--color-muted)'
}

const META: Partial<Record<CueKind, CueStyle>> = {
  objection: {
    icon: AlertTriangle,
    label: 'Objection',
    rule: 'border-l-warning',
    iconBg: 'bg-warning-soft',
    iconText: 'text-warning',
    ringColor: 'var(--color-warning)'
  },
  discovery: {
    icon: Search,
    label: 'Discovery',
    rule: 'border-l-accent',
    iconBg: 'bg-accent-soft',
    iconText: 'text-accent',
    ringColor: 'var(--color-accent)'
  },
  'next-question': {
    icon: MessageCircleQuestion,
    label: 'Ask',
    rule: 'border-l-accent',
    iconBg: 'bg-accent-soft',
    iconText: 'text-accent',
    ringColor: 'var(--color-accent)'
  },
  'buying-signal': {
    icon: TrendingUp,
    label: 'Buying signal',
    rule: 'border-l-positive',
    iconBg: 'bg-positive-soft',
    iconText: 'text-positive',
    ringColor: 'var(--color-positive)'
  },
  pace: {
    icon: Gauge,
    label: 'Pace',
    rule: 'border-l-line-strong',
    iconBg: 'bg-elevated',
    iconText: 'text-muted',
    ringColor: 'var(--color-muted)'
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
 * INSTRUMENT PANEL: an opaque card on the live screen's shared material
 * (surface, 1px line, --shadow-hud, --radius-card) rather than glass floating
 * over scrolling transcript text; a 3px left rule carries the kind's colour
 * instead of a tinted ring. The lifetime is a ring around the Dismiss button —
 * the countdown sits on the control it counts down to — and it is a static
 * ring, not an empty one, when the OS asks for reduced motion (index.css).
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
  const ringStyle = {
    animationDuration: `${AUTO_DISMISS_MS}ms`,
    '--cue-ring-color': meta.ringColor
  } as CSSProperties

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto relative w-full rounded-[var(--radius-card)] border border-line border-l-[3px] bg-surface p-3 shadow-[var(--shadow-hud)] transition-all duration-300',
        meta.rule,
        shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-md', meta.iconBg)}>
          <Icon className={cn('h-3.5 w-3.5', meta.iconText)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-semibold tracking-wide text-faint uppercase">{meta.label}</p>
          <p className="text-sm font-medium text-ink">{cue.text}</p>
        </div>
        {/* One Dismiss button, with the cue's remaining life drawn around it.
            The ring is a decorative span behind the button, never a control. */}
        <span className="relative grid h-8 w-8 shrink-0 place-items-center">
          <span
            aria-hidden="true"
            className="cue-ring pointer-events-none absolute inset-0 rounded-full"
            style={ringStyle}
          />
          <IconButton icon={X} onClick={onDismiss} label="Dismiss" className="rounded-full" />
        </span>
      </div>
    </div>
  )
}
