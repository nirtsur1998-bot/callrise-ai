import { useEffect, useState } from 'react'
import type { Call } from '@renderer/features/calls/types'
import type { Task } from '@renderer/features/tasks/types'

export interface LinkedCall {
  call: Call
  tasks: Task[]
}

export interface UseContactCallHistory {
  loading: boolean
  linked: LinkedCall[]
}

/** Every call linked to a contact, newest first, each paired with its tasks —
 *  the data behind the Contact detail view and a Deal's linked-contact
 *  history (they show the same thing: full context on that person). */
export function useContactCallHistory(contactId: string): UseContactCallHistory {
  const [loading, setLoading] = useState(true)
  const [linked, setLinked] = useState<LinkedCall[]>([])

  useEffect(() => {
    let active = true
    // Reset for the newly-selected contact; state is only set again after the
    // await (and only while still mounted/current), matching the mount-time
    // data-fetch pattern used elsewhere (e.g. useTasks).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    void (async () => {
      try {
        const [summaries, tasks] = await Promise.all([
          window.api.calls.list(),
          window.api.tasks.list()
        ])
        const matches = summaries.filter((c) => c.contactId === contactId)
        const calls = (await Promise.all(matches.map((c) => window.api.calls.get(c.id)))).filter(
          (c): c is Call => c !== null
        )
        calls.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        if (!active) return
        setLinked(calls.map((call) => ({ call, tasks: tasks.filter((t) => t.callId === call.id) })))
      } catch {
        /* show the (possibly empty) history rather than a skeleton forever */
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [contactId])

  return { loading, linked }
}
