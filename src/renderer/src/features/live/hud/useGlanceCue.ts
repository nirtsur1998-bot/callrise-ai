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

  // BUG-253 — RE-SEED THE CLOCK, don't just re-arm the interval.
  //
  // `now` has exactly one writer: the tick below. While `enabled` is false —
  // the rep is on the 'Full' HUD layout — the interval is torn down and `now`
  // is FROZEN at whatever it last read. Re-arming alone left the first fresh
  // value 400 ms away, so on the enabling frame the hook compared a live cue's
  // TTL against a clock from however long ago the layout was switched; the
  // first tick then jumped `now` forward by that whole span and
  // `now - readyAt` crossed GLANCE_TTL_MS at once. The cue flashed and
  // vanished, and the absorption ledger recorded a `shown` AND an `expired`
  // for a cue nobody had time to read — diluting the very rate the HUD exists
  // to measure.
  //
  // A frozen `now` also sits BEHIND repLastRef/otherLastRef, which keep
  // advancing because the segments effect above has no `enabled` guard. That
  // made `repSilentFor` negative, so `canDeliverNow`'s hold branch could not
  // pass at all. Seeding closes both.
  //
  // NOT the line eslint flags. `react-hooks/refs` points at the readyAt stamp
  // below, and gating THAT on `enabled` fixes nothing: the enabling render
  // still carries the frozen value, so it would stamp the same stale number
  // the unguarded version already holds. A lint hit is a hypothesis about a
  // neighbourhood, not a diagnosis of a line (species 92, species 106).
  useEffect(() => {
    if (!enabled) return
    const fresh = performance.now()
    // `now` is the FROZEN value here: this effect body closes over the render
    // in which `enabled` became true, and that render still had the stale
    // clock. The difference is exactly how long the HUD was hidden.
    const hiddenFor = fresh - now
    // Shift every pending stamp forward by that span, rather than clearing
    // them. A cue's TTL should measure how long the rep has had it IN FRONT OF
    // THEM, and time on another layout is not that. Clearing looks equivalent
    // and is not: the stamp is taken when a candidate first appears, so with
    // the entry gone and the candidate unchanged nothing would re-stamp it,
    // `decision`'s `?? now` fallback would return 0 on every tick, and the cue
    // could then never expire at all. Found by red-checking this fix, not by
    // reading it.
    if (hiddenFor > 0) {
      for (const [cueId, readyAt] of readyAtRef.current) {
        readyAtRef.current.set(cueId, readyAt + hiddenFor)
      }
    }
    setNow(fresh)
    const id = setInterval(() => setNow(performance.now()), POLL_MS)
    return () => clearInterval(id)
    // `now` is deliberately not a dep: this must run on the enabled edge only,
    // and depending on it would re-run every tick and re-shift every stamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const candidate: LiveCue | null = useMemo(() => {
    const pick = interrupt ?? suggestions[0] ?? null
    if (!pick || dismissedIds.has(pick.id) || !hasEvidence(pick.evidence)) return null
    return pick
  }, [interrupt, suggestions, dismissedIds])

  // Remember when each candidate first became ready, so the TTL runs from then.
  //
  // In an effect rather than in render — this was the statement
  // `react-hooks/refs` flagged, and a render must never write (the same rule
  // the purity note below records). Behaviour is unchanged: on the frame a
  // candidate first appears there is no entry yet, and `decision` falls back to
  // `?? now`, which is the value this effect is about to store.
  useEffect(() => {
    if (!candidate || readyAtRef.current.has(candidate.id)) return
    readyAtRef.current.set(candidate.id, now)
    // `now` deliberately absent from the deps: this stamps the FIRST time a
    // candidate is seen, and re-running it every tick is exactly what the
    // `has()` guard exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate])

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
