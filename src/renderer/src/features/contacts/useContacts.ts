import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@renderer/features/notifications/useToast'
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
  /** False when the delete was blocked (deals still reference the contact). */
  remove: (id: string) => Promise<boolean>
}

export function useContacts(): UseContacts {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)
  const toast = useToast()

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

  useEffect(() => {
    // A cloud restore can add/update/delete contacts in the background (when
    // Contacts sync is opted into) — re-read so the list reflects it.
    return window.api.backup.onChanged(() => void refresh())
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
      try {
        const res = await window.api.contacts.delete(id)
        await refresh()
        if (res.ok) toast.success('Contact deleted')
        return res.ok
      } catch {
        // Not the "still has open deals" block — an actual failure. Report it
        // via toast rather than `false`, which would misleadingly show the
        // deals-attached banner instead of the real error.
        toast.error('Could not delete the contact. Please try again.')
        await refresh()
        return true
      }
    },
    [refresh, toast]
  )

  return { contacts, loading, refresh, create, update, remove }
}
