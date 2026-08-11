import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '@renderer/features/tasks/types'
import type { CallSummary } from '@renderer/features/calls/types'
import type { CalendarEvent } from './types'
import { useToast } from '@renderer/features/notifications/useToast'

export type EventCreateInput = Parameters<typeof window.api.events.create>[0]
export type EventUpdateInput = Parameters<typeof window.api.events.update>[1]

export interface UseCalendar {
  events: CalendarEvent[]
  tasks: Task[]
  calls: CallSummary[]
  googleEvents: CalendarEvent[]
  /** True while a Google network pull is in flight. */
  googleSyncing: boolean
  /** When the last successful Google pull finished (epoch ms), or null. */
  googleLastSynced: number | null
  /** True when two-way sync is on, so Google events can be edited/deleted. */
  googleWritable: boolean
  outlookEvents: CalendarEvent[]
  /** True while an Outlook network pull is in flight. */
  outlookSyncing: boolean
  /** When the last successful Outlook pull finished (epoch ms), or null. */
  outlookLastSynced: number | null
  /** True when two-way sync is on, so Outlook events can be edited/deleted. */
  outlookWritable: boolean
  loading: boolean
  createEvent: (input: EventCreateInput) => Promise<void>
  /** Returns false (and shows an error toast) when the write actually failed
   *  on disk, so a caller like the edit dialog can stay open instead of
   *  closing as if the edit saved (BUG-024). */
  updateEvent: (id: string, patch: EventUpdateInput) => Promise<boolean>
  deleteEvent: (id: string) => Promise<boolean>
  /** Edit a Google/Outlook event by adopting it into the local (editable) store. */
  adoptEvent: (event: CalendarEvent, patch: EventUpdateInput) => Promise<void>
  /** Delete a Google/Outlook-originated event from the app and from the provider. */
  deleteExternalEvent: (event: CalendarEvent) => Promise<void>
  /** Re-pull Google events from the network (used on connect/refresh). */
  refreshGoogle: () => Promise<void>
  /** Re-pull Outlook events from the network (used on connect/refresh). */
  refreshOutlook: () => Promise<void>
}

export function useCalendar(): UseCalendar {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  const [googleSyncing, setGoogleSyncing] = useState(false)
  const [googleLastSynced, setGoogleLastSynced] = useState<number | null>(null)
  const [googleWritable, setGoogleWritable] = useState(false)
  const [outlookEvents, setOutlookEvents] = useState<CalendarEvent[]>([])
  const [outlookSyncing, setOutlookSyncing] = useState(false)
  const [outlookLastSynced, setOutlookLastSynced] = useState<number | null>(null)
  const [outlookWritable, setOutlookWritable] = useState(false)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)
  const toast = useToast()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Events are editable; tasks and calls are read-only overlays. State is only
  // set after the awaits, so this is safe to call from an effect.
  const refresh = useCallback(async () => {
    try {
      // Google/Outlook events come from the local cache here (instant, no
      // network) so they persist across local edits; refreshGoogle()/
      // refreshOutlook() re-pull from the network.
      const [e, t, c, g, o] = await Promise.all([
        window.api.events.list(),
        window.api.tasks.list(),
        window.api.calls.list(),
        window.api.google.cachedEvents(),
        window.api.outlook.cachedEvents()
      ])
      if (!mountedRef.current) return
      setEvents(e)
      setTasks(t)
      setCalls(c)
      setGoogleEvents(g)
      setOutlookEvents(o)
    } catch {
      /* keep the last known data */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  // Network pull from Google. A transient outage keeps the cached events shown;
  // only an explicit not-connected clears them.
  const refreshGoogle = useCallback(async () => {
    setGoogleSyncing(true)
    try {
      // Two-way sync on ⇒ Google events become editable (adoptable) in the app.
      const status = await window.api.google.getStatus()
      if (mountedRef.current) setGoogleWritable(status.connected && status.mode === 'readwrite')
      const res = await window.api.google.pullEvents()
      if (!mountedRef.current) return
      if (res.ok) {
        setGoogleEvents(res.events)
        setGoogleLastSynced(Date.now())
        // We're online — drain any pushes/deletes that failed while offline.
        void window.api.events.reconcile()
      } else if (res.error === 'not-connected') {
        setGoogleEvents([])
        setGoogleLastSynced(null)
      }
    } catch {
      /* keep the cached events */
    } finally {
      if (mountedRef.current) setGoogleSyncing(false)
    }
  }, [])

  // Same shape as refreshGoogle, aimed at Outlook.
  const refreshOutlook = useCallback(async () => {
    setOutlookSyncing(true)
    try {
      const status = await window.api.outlook.getStatus()
      if (mountedRef.current) setOutlookWritable(status.connected && status.mode === 'readwrite')
      const res = await window.api.outlook.pullEvents()
      if (!mountedRef.current) return
      if (res.ok) {
        setOutlookEvents(res.events)
        setOutlookLastSynced(Date.now())
        void window.api.events.reconcile()
      } else if (res.error === 'not-connected') {
        setOutlookEvents([])
        setOutlookLastSynced(null)
      }
    } catch {
      /* keep the cached events */
    } finally {
      if (mountedRef.current) setOutlookSyncing(false)
    }
  }, [])

  useEffect(() => {
    // Load once on mount; a calendar fetch is exactly the intended pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    void refreshGoogle()
    void refreshOutlook()
  }, [refresh, refreshGoogle, refreshOutlook])

  // A background Google push (fire-and-forget) stamps the event's link after
  // the create returns; re-read local events then so the pulled copy dedups.
  useEffect(() => {
    const off = window.api.events.onChanged(() => void refresh())
    return off
  }, [refresh])

  const createEvent = useCallback(
    async (input: EventCreateInput) => {
      await window.api.events.create(input)
      await refresh()
    },
    [refresh]
  )

  const updateEvent = useCallback(
    async (id: string, patch: EventUpdateInput) => {
      let ok = true
      try {
        const result = await window.api.events.update(id, patch)
        ok = result !== null
      } catch {
        ok = false
      }
      if (!ok) toast.error('Could not save that change. Please try again.')
      await refresh()
      return ok
    },
    [refresh, toast]
  )

  const deleteEvent = useCallback(
    async (id: string) => {
      let ok = true
      try {
        const result = await window.api.events.delete(id)
        ok = result.ok
      } catch {
        ok = false
      }
      if (!ok) toast.error('Could not delete the event. Please try again.')
      await refresh()
      return ok
    },
    [refresh, toast]
  )

  // Editing a Google event adopts it: create a linked local event carrying the
  // edit, which PATCHes the same Google event and dedups the pulled copy.
  const adoptEvent = useCallback(
    async (event: CalendarEvent, patch: EventUpdateInput) => {
      // Fall back to the source value only when a field is truly ABSENT
      // (undefined). An intentional null (e.g. notes cleared to empty) must pass
      // through, or clearing a Google event's notes would be silently reverted.
      await window.api.events.adopt({
        title: patch.title !== undefined ? patch.title : event.title,
        start: patch.start !== undefined ? patch.start : event.start,
        end: patch.end !== undefined ? patch.end : event.end,
        allDay: patch.allDay !== undefined ? patch.allDay : event.allDay,
        notes: patch.notes !== undefined ? patch.notes : (event.notes ?? null),
        contactId: patch.contactId !== undefined ? patch.contactId : (event.contactId ?? null),
        dealId: patch.dealId !== undefined ? patch.dealId : (event.dealId ?? null),
        provider: event.provider,
        externalId: event.externalId,
        remoteUpdatedAt: event.remoteUpdatedAt
      })
      await refresh()
    },
    [refresh]
  )

  const deleteExternalEvent = useCallback(
    async (event: CalendarEvent) => {
      await window.api.events.deleteExternal({
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        notes: event.notes ?? null,
        provider: event.provider,
        externalId: event.externalId
      })
      await refresh()
    },
    [refresh]
  )

  return {
    events,
    tasks,
    calls,
    googleEvents,
    googleSyncing,
    googleLastSynced,
    googleWritable,
    outlookEvents,
    outlookSyncing,
    outlookLastSynced,
    outlookWritable,
    loading,
    createEvent,
    updateEvent,
    deleteEvent,
    adoptEvent,
    deleteExternalEvent,
    refreshGoogle,
    refreshOutlook
  }
}
