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
  loading: boolean
  createEvent: (input: EventCreateInput) => Promise<void>
  updateEvent: (id: string, patch: EventUpdateInput) => Promise<void>
  deleteEvent: (id: string) => Promise<void>
}

export function useCalendar(): UseCalendar {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [calls, setCalls] = useState<CallSummary[]>([])
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
      const [e, t, c] = await Promise.all([
        window.api.events.list(),
        window.api.tasks.list(),
        window.api.calls.list()
      ])
      if (!mountedRef.current) return
      setEvents(e)
      setTasks(t)
      setCalls(c)
    } catch {
      /* keep the last known data */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Load once on mount; a calendar fetch is exactly the intended pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
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

  return { events, tasks, calls, loading, createEvent, updateEvent, deleteEvent }
}
