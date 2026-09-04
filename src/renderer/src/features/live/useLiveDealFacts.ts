// M34 3d — resolve the deal facts for the matched meeting, ONCE.
//
// Keyed on the meeting id, not on any live state: the line must never update
// mid-call. A fact that changes while the rep is talking is an instrument,
// and 3c is about having fewer of those. If the meeting changes (a different
// event matches "now"), the facts are re-resolved for the new meeting; while
// the same meeting stays matched, nothing here re-runs.
//
// Only a matched calendar meeting carries a contact/deal link on the live
// surface (the same link Deal Intelligence grounds on). No meeting → null,
// and no attempt to infer a contact from a name.
import { useEffect, useState } from 'react'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import { buildLiveDealFacts, newestCall, storedNextAction, type LiveDealFacts } from './dealFacts'

export function useLiveDealFacts(meeting: CalendarEvent | null): LiveDealFacts | null {
  const [facts, setFacts] = useState<LiveDealFacts | null>(null)
  const meetingId = meeting?.id ?? null
  const contactId = meeting?.contactId
  const dealId = meeting?.dealId

  useEffect(() => {
    let cancelled = false
    if (!meetingId || (!contactId && !dealId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing derived state when the meeting goes away
      setFacts(null)
      return
    }
    void (async () => {
      try {
        const [deals, stages, calls] = await Promise.all([
          dealId ? window.api.deals.list() : Promise.resolve([]),
          dealId ? window.api.dealStages.get() : Promise.resolve([]),
          contactId ? window.api.calls.list() : Promise.resolve([])
        ])
        const deal = dealId ? deals.find((d) => d.id === dealId) : undefined
        const stage = deal ? stages.find((s) => s.id === deal.stageId) : undefined
        const contactCalls = contactId ? calls.filter((c) => c.contactId === contactId) : []
        const last = newestCall(contactCalls)
        let lastCallNextAction: string | undefined
        if (last) {
          const full = await window.api.calls.get(last.id)
          if (full) lastCallNextAction = storedNextAction(full)
        }
        if (cancelled) return
        setFacts(buildLiveDealFacts({ deal, stage, contactCalls, lastCallNextAction }))
      } catch {
        // A failed lookup shows nothing — never a placeholder, never a guess.
        if (!cancelled) setFacts(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // Deliberately keyed on the meeting's identity and its two link ids only.
  }, [meetingId, contactId, dealId])

  return facts
}
