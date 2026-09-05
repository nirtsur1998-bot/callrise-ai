import { useEffect, useState } from 'react'
import { MessageCircleQuestion, Search, AlertTriangle, TrendingUp, Zap, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { IconButton } from '@renderer/components/IconButton'
import type { CueKind, LiveCue } from '../useLiveCues'

const META: Partial<Record<CueKind, { icon: LucideIcon; label: string; tint: string }>> = {
  // Deterministic, so it lands in ~400ms — but still reference material rather
  // than a nudge, which is why it shares the rail instead of interrupting.
  battlecard: { icon: Zap, label: 'Battlecard', tint: 'text-accent' },
  objection: { icon: AlertTriangle, label: 'Objection', tint: 'text-warning' },
  discovery: { icon: Search, label: 'Discovery', tint: 'text-accent' },
  'next-question': { icon: MessageCircleQuestion, label: 'Ask', tint: 'text-accent' },
  'buying-signal': { icon: TrendingUp, label: 'Buying signal', tint: 'text-positive' }
}

/**
 * The side rail: model-generated suggestions (§4.3).
 *
 * Everything here is deliberately quieter than the interrupt cue that shares
 * the screen with it, because it arrives 1.5–2.5s after the moment it
 * describes. It does not slide in, it does not count down, it does not take
 * the corner a deterministic cue would use, and it never auto-dismisses
 * mid-read. The rep reads it when they choose to and it waits.
 *
 * If this ever starts animating in or stealing the eye, it has quietly become
 * an interrupt again and the split is gone.
 */
export function SuggestionRail({
  suggestions,
  onDismiss,
  collapsed = false
}: {
  suggestions: LiveCue[]
  onDismiss: (id: number) => void
  /** M34 3c — Quiet mode: show only a count the rep can open. Nothing is
   *  dropped; the suggestions keep accumulating behind the pill exactly as
   *  they would on the rail, and the rail returns the moment Quiet is off. */
  collapsed?: boolean
}): React.JSX.Element | null {
  const [peek, setPeek] = useState(false)
  // A peek is for THIS quiet stretch. When Quiet is switched off and on again
  // the pill must come back, not stay open from a click ten minutes ago.
  useEffect(() => {
    if (collapsed) setPeek(false)
  }, [collapsed])
  if (suggestions.length === 0) return null

  if (collapsed && !peek) {
    return (
      <button
        type="button"
        onClick={() => setPeek(true)}
        aria-label={`Show ${suggestions.length} coaching suggestion${suggestions.length === 1 ? '' : 's'}`}
        className="glass-hud pointer-events-auto rounded-full px-3 py-1 text-[11px] font-medium text-muted hover:text-ink"
      >
        {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'}
      </button>
    )
  }

  return (
    <div
      // `log`, not `status`: a status region is announced the moment it
      // changes, which is an auditory interrupt — precisely what this tier is
      // not allowed to be. `polite` lets a screen reader finish its sentence.
      role="log"
      aria-live="polite"
      aria-label="Coaching suggestions"
      className="flex w-full flex-col gap-2"
    >
      {/* Oldest first, so the newest sits closest to the interrupt cue below —
          the eye lands on the freshest advice without anything having to move. */}
      {[...suggestions].reverse().map((s, index) => {
        const meta = META[s.kind]
        if (!meta) return null
        const Icon = meta.icon
        // Older items recede rather than disappear, so the newest reads first
        // without anything having to move.
        const isNewest = index === suggestions.length - 1
        return (
          <div
            key={s.id}
            className={cn(
              'glass-hud pointer-events-auto relative w-full rounded-2xl p-2.5 transition-opacity',
              isNewest ? 'opacity-100' : 'opacity-55 hover:opacity-90'
            )}
          >
            <span className="glass-sheen rounded-2xl" />
            <div className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', meta.tint)} />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold tracking-wide text-faint uppercase">
                  {meta.label}
                </p>
                <p className="text-[13px] leading-snug text-ink">{s.text}</p>
              </div>
              <IconButton
                icon={X}
                label="Dismiss suggestion"
                onClick={() => onDismiss(s.id)}
                className="h-6 w-6 shrink-0 rounded-full"
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
