import { useEffect, useRef, useState } from 'react'
import { CollapseTransition } from './CollapseTransition'
import { HealthScoreCard } from './HealthScoreCard'
import { NudgeCard } from './NudgeCard'
import { PresenceHeader } from './PresenceHeader'
import { StatusNotice } from './StatusNotice'
import type { DealIntelligencePanelProps } from './types'

const CLOCK_TICK_MS = 1000
/** How long a new nudge keeps the header dot's arrival flash lit. Matches
 *  the `.flash` keyframe's own duration (index.css) so the glow finishes
 *  exactly as the state resets — a mismatch would either cut the glow off
 *  early or leave the dot looking "stuck" for a beat after it's done. */
const ARRIVAL_FLASH_MS = 600
/** How long the "quiet is normal" notice stays up before receding to just
 *  the header dot. Long enough to read once, short enough that it doesn't
 *  become the permanent fixture the product's own "rare nudges" framing
 *  argues against. */
const QUIET_GRACE_MS = 9000

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Ticks a shared "now" once a second, but only while a nudge's relative
 *  timestamp ("12s ago") could actually change on screen. An empty panel —
 *  which is most of a call, since nudges are meant to be rare — has nothing
 *  to redraw, so it costs nothing while waiting instead of running a timer
 *  no one can see. */
function useTickingClock(shouldTick: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!shouldTick) return undefined
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(id)
  }, [shouldTick])
  return now
}

/** Flashes true for ARRIVAL_FLASH_MS the first time a nudge id shows up that
 *  wasn't in the list on the previous render — the signal that makes the
 *  header dot read as the point every card visually launches from, instead
 *  of a decorative status light that happens to sit above an unrelated
 *  list. Fires at most once per batch of simultaneous arrivals: several
 *  nudges landing in the same tick is still one "a signal just arrived"
 *  moment, not N overlapping flashes. */
function useArrivalFlash(nudgeIds: readonly string[]): boolean {
  const [flashing, setFlashing] = useState(false)
  const seenRef = useRef<ReadonlySet<string>>(new Set())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const current = new Set(nudgeIds)
    const hasNew = nudgeIds.some((id) => !seenRef.current.has(id))
    seenRef.current = current
    if (!hasNew) return undefined
    setFlashing(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(
      () => setFlashing(false),
      prefersReducedMotion() ? 0 : ARRIVAL_FLASH_MS
    )
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the id list's content (via a fresh array each render), not identity; see the .some() scan above
  }, [nudgeIds.join('|')])

  return flashing
}

/** True while the panel should show the "quiet is normal" explainer — once
 *  per quiet stretch, not for its entire duration. `active + zero nudges`
 *  is the state the product's own framing calls typical, so leaving this
 *  notice up permanently would recreate the exact "always-on widget"
 *  problem the feature is trying to avoid; showing it once and receding to
 *  the header dot proves the point without ever going fully silent (an
 *  always-on system that occasionally goes fully quiet is indistinguishable
 *  from a broken one, which is why the dot in PresenceHeader never leaves). */
function useQuietGraceWindow(isActive: boolean, hasNudges: boolean): boolean {
  const isQuietNow = isActive && !hasNudges
  const [graceOpen, setGraceOpen] = useState(false)
  const wasQuietRef = useRef(false)

  useEffect(() => {
    if (!isQuietNow) {
      wasQuietRef.current = false
      return undefined
    }
    if (wasQuietRef.current) return undefined // already mid-stretch; don't restart the clock
    wasQuietRef.current = true
    setGraceOpen(true)
    const timer = window.setTimeout(
      () => setGraceOpen(false),
      prefersReducedMotion() ? 0 : QUIET_GRACE_MS
    )
    return () => window.clearTimeout(timer)
  }, [isQuietNow])

  // `isQuietNow` is derived straight from props (no state involved), so it
  // gates the result directly — the notice disappears the instant a nudge
  // arrives or status leaves `active` without this hook needing a second,
  // unconditional setState call in the effect above just to "turn it back
  // off." That call would fire on every render where the panel isn't in a
  // quiet stretch, which is exactly the synchronous-setState-in-effect
  // pattern that does needless render-time work React's own lint rule
  // exists to catch — `graceOpen` only ever needs setting, never resetting.
  return isQuietNow && graceOpen
}

/**
 * Live Deal Intelligence — the flagship, always-watching counterpart to
 * Gong-style post-call analytics: rare, high-value nudges surfaced as
 * evidence-first briefs rather than notification toasts.
 *
 * Positioning is deliberately NOT this component's job — no `fixed`/
 * `absolute` on the root, matching how CueCard/SuggestionRail already work
 * in this codebase (the live screen owns one positioned column so
 * independently-floating pieces can never collide). This panel is a fixed-
 * width flex column sized to slot into whichever corner its caller anchors
 * it in; see DESIGN.md for the recommended mount point.
 */
export function DealIntelligencePanel({
  enabled,
  status,
  nudges,
  onDismiss,
  onFeedback,
  healthScore
}: DealIntelligencePanelProps): React.JSX.Element | null {
  // Local, ephemeral "already rated" flags — purely a UI affordance so a rep
  // doesn't see the same thumbs buttons after already clicking one. The
  // engine that actually tunes on this signal owns real persistence; this
  // component only needs to stop offering the same choice twice.
  const [ratedIds, setRatedIds] = useState<Record<string, boolean>>({})

  const nudgeIds = nudges.map((n) => n.id)
  const justArrived = useArrivalFlash(nudgeIds)
  const showQuiet = useQuietGraceWindow(status === 'active', nudges.length > 0)
  const now = useTickingClock(nudges.length > 0)

  if (!enabled) return null

  return (
    <div className="flex w-80 flex-col gap-2">
      {/* The one element on screen for the entire call in every status —
          see PresenceHeader's own doc comment for why this replaces a wider
          masthead-plus-notice combo. */}
      <PresenceHeader status={status} justArrived={justArrived} />

      {/* Tier 2's slower, whole-call read — absent (null) until its first
          pass lands, then persists at its own update cadence independent of
          the status/nudge states below. See HealthScoreCard's own doc
          comment for why this is a separate card rather than folded into
          PresenceHeader. */}
      {healthScore && <HealthScoreCard healthScore={healthScore} />}

      {status === 'idle' && <StatusNotice variant="idle" />}
      {status === 'paused' && <StatusNotice variant="paused" />}
      {status === 'active' && (
        <CollapseTransition open={showQuiet}>
          <StatusNotice variant="quiet" />
        </CollapseTransition>
      )}

      {nudges.length > 0 && (
        <ol
          role="log"
          aria-live="polite"
          aria-label="Live deal intelligence nudges"
          className="flex list-none flex-col gap-2"
        >
          {nudges.map((nudge, index) => (
            <li key={nudge.id}>
              <NudgeCard
                nudge={nudge}
                nowMs={now}
                isNewest={index === 0}
                rated={Boolean(ratedIds[nudge.id])}
                onDismiss={() => onDismiss(nudge.id)}
                onFeedback={
                  onFeedback
                    ? (helpful): void => {
                        // Once true, stays true — flipping a vote after the
                        // fact is a different feature (an edit), not this one.
                        setRatedIds((prev) =>
                          prev[nudge.id] ? prev : { ...prev, [nudge.id]: true }
                        )
                        onFeedback(nudge.id, helpful)
                      }
                    : undefined
                }
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
