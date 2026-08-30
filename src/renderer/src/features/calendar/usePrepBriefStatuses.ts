import { useEffect, useRef, useState } from 'react'
import type { PrepBriefStatus } from '../../../../preload/index.d'
import type { CalendarItem } from './types'
import { briefEligibleEvents } from './chipContext'

/**
 * M31 Slice B — prep-brief status for every chip in the visible range, in
 * one round trip.
 *
 * Read-only by construction: `prepBrief:statuses` never generates a brief
 * and never writes, so this can run on every range change without spending
 * an AI call or racing the real open path.
 *
 * Keyed on the eligible events' ids + start times rather than on the items
 * array identity, so panning to a month with the same meetings doesn't
 * refetch, but MOVING a meeting does — a moved meeting invalidates its own
 * brief (start time is part of the cache key), and the dot has to follow.
 */
export function usePrepBriefStatuses(
  items: CalendarItem[],
  enabled: boolean
): Map<string, PrepBriefStatus> {
  const [statuses, setStatuses] = useState<Map<string, PrepBriefStatus>>(new Map())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const eligible = enabled ? briefEligibleEvents(items, new Date()) : []
  const key = eligible
    .map((i) => `${i.event?.id}@${i.start.getTime()}`)
    .sort()
    .join('|')

  useEffect(() => {
    if (!enabled || !key) {
      setStatuses((prev) => (prev.size === 0 ? prev : new Map()))
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const inputs = eligible.map((i) => ({
          eventId: i.event!.id,
          title: i.event!.title,
          startIso: i.event!.start,
          attendees: i.event!.attendees ?? [],
          contactId: i.event!.contactId,
          dealId: i.event!.dealId
        }))
        const result = await window.api.prepBrief.statuses(inputs)
        if (cancelled || !mountedRef.current) return
        setStatuses(new Map(Object.entries(result)))
      } catch {
        // A failed status read must leave the chips with NO dot rather than
        // a stale one from a previous range — an absent dot says nothing,
        // which is the honest outcome when we don't know.
        if (!cancelled && mountedRef.current) setStatuses(new Map())
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the content-derived dep; `eligible` is rebuilt each render by design
  }, [key, enabled])

  return statuses
}
