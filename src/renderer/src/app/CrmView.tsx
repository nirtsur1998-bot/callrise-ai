import { useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { ContactsView } from '@renderer/features/contacts/ContactsView'
import { DealsView } from '@renderer/features/deals/DealsView'

type CrmTab = 'contacts' | 'deals'

const TABS: { id: CrmTab; label: string }[] = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'deals', label: 'Deals' }
]

/** The CRM hub: Contacts (Phase 1) and Deals (Phase 3) as tabs of one screen,
 *  rather than separate sidebar items — they're one feature area. */
export function CrmView(): React.JSX.Element {
  const [tab, setTab] = useState<CrmTab>('contacts')

  return (
    <div>
      <div className="mb-5 flex items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-lg px-3.5 py-1.5 text-sm font-medium transition',
              tab === t.id
                ? 'bg-accent-soft text-ink'
                : 'text-muted hover:bg-elevated hover:text-ink'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'contacts' ? <ContactsView /> : <DealsView />}
    </div>
  )
}
