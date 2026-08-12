import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search, Plus, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { ContactFormDialog, type ContactFormValues } from './ContactFormDialog'
import type { Contact } from './types'

interface ContactPickerProps {
  /** The linked contact's id, or undefined for "no contact linked". */
  value: string | undefined
  contacts: Contact[]
  onSelect: (contactId: string | undefined) => void
  /** Quick-create from the picker; returns the new contact so it can be selected. */
  onCreate: (input: ContactFormValues) => Promise<Contact | null>
  /** Hide the unlink (X) button — for callers where a contact is mandatory
   *  (e.g. a deal always belongs to someone), only "Change" is offered. */
  required?: boolean
}

/** A searchable dropdown of existing contacts, with a "create new" shortcut —
 *  used to link a saved call to a contact (manual fallback for calls with no
 *  matching calendar event). */
export function ContactPicker({
  value,
  contacts,
  onSelect,
  onCreate,
  required
}: ContactPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => contacts.find((c) => c.id === value), [contacts, value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    // BUG-047: capture phase, not bubble — belt-and-suspenders alongside the
    // real fix in Modal.tsx (which used to stopPropagation() every mousedown
    // inside the dialog panel, silently absorbing this listener's chance to
    // ever see a click on a different field in the same dialog; Modal.tsx no
    // longer does that). Kept on capture anyway so this picker is correct
    // regardless of what any future ancestor does with propagation.
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) => [c.name, c.company].some((f) => f?.toLowerCase().includes(q)))
  }, [contacts, query])

  return (
    <div ref={rootRef} className="relative">
      {selected ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm">
          <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
            {selected.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-ink">{selected.name}</p>
            {selected.company && (
              <p className="truncate text-[11px] text-faint">{selected.company}</p>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOpen(true)}
            className="border-line py-1"
          >
            Change
          </Button>
          {!required && (
            <IconButton icon={X} label="Unlink contact" onClick={() => onSelect(undefined)} />
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-faint transition hover:text-ink focus:border-accent focus:outline-none"
        >
          Link a contact
          <ChevronDown className="h-4 w-4 shrink-0" />
        </button>
      )}

      {open && (
        <div className="animate-pop absolute z-50 mt-1.5 w-full min-w-[260px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
          <div className="relative border-b border-line-soft p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false)
              }}
              placeholder="Search contacts…"
              className="w-full rounded-lg bg-canvas py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-faint focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {results.length === 0 ? (
              <p className="px-3 py-3 text-center text-[13px] text-faint">No matches.</p>
            ) : (
              results.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onSelect(c.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition hover:bg-elevated',
                    c.id === value && 'bg-accent-soft text-ink'
                  )}
                >
                  <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                    {c.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{c.name}</p>
                    {c.company && <p className="truncate text-[11px] text-faint">{c.company}</p>}
                  </div>
                </button>
              ))
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setCreating(true)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 border-t border-line-soft px-3 py-2 text-left text-sm text-accent transition hover:bg-elevated"
          >
            <Plus className="h-3.5 w-3.5" /> Add new contact
          </button>
        </div>
      )}

      {creating && (
        <ContactFormDialog
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            const contact = await onCreate(values)
            setCreating(false)
            if (contact) onSelect(contact.id)
          }}
        />
      )}
    </div>
  )
}
