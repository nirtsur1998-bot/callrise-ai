import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '@renderer/features/tasks/types'
import type { CallSummary } from '@renderer/features/calls/types'
import type { CalendarEvent } from './types'

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
  loading: boolean
  createEvent: (input: EventCreateInput) => Promise<void>
  updateEvent: (id: string, patch: EventUpdateInput) => Promise<void>
  deleteEvent: (id: string) => Promise<void>
  /** Re-pull Google events from the network (used on connect/refresh). */
  refreshGoogle: () => Promise<void>
}

export function useCalendar(): UseCalendar {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  const [googleSyncing, setGoogleSyncing] = useState(false)
  const [googleLastSynced, setGoogleLastSynced] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

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
      // Google events come from the local cache here (instant, no network) so
      // they persist across local edits; refreshGoogle() re-pulls from Google.
      const [e, t, c, g] = await Promise.all([
        window.api.events.list(),
        window.api.tasks.list(),
        window.api.calls.list(),
        window.api.google.cachedEvents()
      ])
      if (!mountedRef.current) return
      setEvents(e)
      setTasks(t)
      setCalls(c)
      setGoogleEvents(g)
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
      const res = await window.api.google.pullEvents()
      if (!mountedRef.current) return
      if (res.ok) {
        setGoogleEvents(res.events)
        setGoogleLastSynced(Date.now())
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

  useEffect(() => {
    // Load once on mount; a calendar fetch is exactly the intended pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    void refreshGoogle()
  }, [refresh, refreshGoogle])

  const createEvent = useCallback(
    async (input: EventCreateInput) => {
      await window.api.events.create(input)
      await refresh()
    },
    [refresh]
  )

  const updateEvent = useCallback(
    async (id: string, patch: EventUpdateInput) => {
      await window.api.events.update(id, patch)
      await refresh()
    },
    [refresh]
  )

  const deleteEvent = useCallback(
    async (id: string) => {
      await window.api.events.delete(id)
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
    loading,
    createEvent,
    updateEvent,
    deleteEvent,
    refreshGoogle
  }
}
