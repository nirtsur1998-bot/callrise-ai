import { useCallback, useEffect, useRef, useState } from 'react'
import type { Contact } from './types'

// Derive the create/update payload shapes straight from the preload bridge so
// they can never drift from what the main process actually accepts.
export type ContactCreateInput = Parameters<typeof window.api.contacts.create>[0]
export type ContactUpdateInput = Parameters<typeof window.api.contacts.update>[1]

export interface UseContacts {
  contacts: Contact[]
  loading: boolean
  refresh: () => Promise<void>
  create: (input: ContactCreateInput) => Promise<Contact | null>
  update: (id: string, patch: ContactUpdateInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function useContacts(): UseContacts {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // State is only set after the await (and only while mounted), so this is
  // safe to call straight from an effect without extra render churn.
  const refresh = useCallback(async () => {
    try {
      const list = await window.api.contacts.list()
      if (!mountedRef.current) return
      setContacts(list)
    } catch {
      /* keep the last known list */
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Load contacts once on mount. The rule flags any setState reachable from
    // an effect, but a mount-time data fetch (state set only after the await,
    // and only while mounted) is exactly the intended pattern here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (input: ContactCreateInput) => {
      const contact = await window.api.contacts.create(input)
      await refresh()
      return contact
    },
    [refresh]
  )

  const update = useCallback(
    async (id: string, patch: ContactUpdateInput) => {
      await window.api.contacts.update(id, patch)
      await refresh()
    },
    [refresh]
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.contacts.delete(id)
      await refresh()
    },
    [refresh]
  )

  return { contacts, loading, refresh, create, update, remove }
}
