import { useEffect, useMemo, useRef, useState } from 'react'
import type { CallSegment } from '@renderer/features/calls/types'
import type { LiveCue } from '@renderer/features/live/useLiveCues'
import { canDeliverNow, hasEvidence, recordAbsorption } from './hudCore'
import type { GlanceCue } from './GlanceLine'

const GLANCE_TTL_MS = 20_000
const POLL_MS = 400

/**
 * M36 Stage 2 — what the glance line shows, and when.
 *
 * Priority: the deterministic interrupt (pace) over the newest suggestion.
 * Delivery: a cue that becomes ready while the rep is speaking is HELD until
 * the rep's lull (hudCore.canDeliverNow) — a cue over the rep's own sentence
 * is worse than a late one. Expiry: 20 s on screen, then recorded as expired
 * and gone; a cue held past its own TTL is dropped unshown and recorded as
 * expired too, never shown late.
 *
 * "Who spoke last, and when" comes from the segments' roles and the moment
 * the segment list changed; that is measured, not guessed.
 */
export function useGlanceCue(
  interrupt: LiveCue | null,
  suggestions: LiveCue[],
  segments: CallSegment[],
  enabled: boolean
): { cue: GlanceCue | null; dismiss: (id: number) => void; latestAt: number | null; now: number } {
  const [now, setNow] = useState(() => performance.now())
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(() => new Set())
  const repLastRef = useRef<number | null>(null)
  const otherLastRef = useRef<number | null>(null)
  const latestAtRef = useRef<number | null>(null)
  const readyAtRef = useRef<Map<number, number>>(new Map())
  const expiredRef = useRef<Set<number>>(new Set())

  // measured speaking timestamps: the moment the segment list changed, by role
  const lastSeg = segments.length > 0 ? segments[segments.length - 1] : null
  const lastSegKey = lastSeg ? `${segments.length}:${lastSeg.text.length}` : ''
  useEffect(() => {
    if (!lastSeg) return
    const t = performance.now()
    latestAtRef.current = t
    if (lastSeg.role === 'rep') repLastRef.current = t
    else if (lastSeg.role === 'other') otherLastRef.current = t
    // 'unknown' updates neither: an unsure speaker must not count as a lull
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the list changing, not the object
  }, [lastSegKey])

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(performance.now()), POLL_MS)
    return () => clearInterval(id)
  }, [enabled])

  const candidate: LiveCue | null = useMemo(() => {
    const pick = interrupt ?? suggestions[0] ?? null
    if (!pick || dismissedIds.has(pick.id) || !hasEvidence(pick.evidence)) return null
    return pick
  }, [interrupt, suggestions, dismissedIds])

  // remember when each candidate first became ready, so the TTL runs from then
  if (candidate && !readyAtRef.current.has(candidate.id)) readyAtRef.current.set(candidate.id, now)

  // Pure: decides what to show. The one side effect (recording an expiry in
  // the absorption ledger) lives in the effect below — a render must never
  // write (react-hooks/purity, found by the lint pass after BUG-194).
  const decision: { cue: GlanceCue | null; expired: LiveCue | null } = useMemo(() => {
    if (!enabled || !candidate) return { cue: null, expired: null }
    const readyAt = readyAtRef.current.get(candidate.id) ?? now
    if (now - readyAt > GLANCE_TTL_MS) return { cue: null, expired: candidate }
    const deliverable = canDeliverNow({ now, repLastSpokeAt: repLastRef.current, otherLastSpokeAt: otherLastRef.current })
    if (!deliverable) return { cue: null, expired: null }
    return {
      cue: { id: candidate.id, kind: candidate.kind, text: candidate.text, evidence: candidate.evidence, source: candidate.source },
      expired: null
    }
  }, [enabled, candidate, now])

  useEffect(() => {
    const expired = decision.expired
    if (!expired || expiredRef.current.has(expired.id)) return
    expiredRef.current.add(expired.id)
    recordAbsorption({ type: 'expired', cueId: expired.id, kind: expired.kind, at: Date.now() })
  }, [decision.expired])

  const dismiss = (id: number): void => setDismissedIds((prev) => new Set(prev).add(id))

  return { cue: decision.cue, dismiss, latestAt: latestAtRef.current, now }
}
