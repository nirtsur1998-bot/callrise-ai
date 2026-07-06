import { useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { ContactsView } from '@renderer/features/contacts/ContactsView'
import { DealsView } from '@renderer/features/deals/DealsView'
import { FollowUpDigest } from '@renderer/features/deals/FollowUpDigest'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'

type CrmTab = 'contacts' | 'deals' | 'followups'

const TABS: { id: CrmTab; label: string }[] = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'deals', label: 'Deals' },
  { id: 'followups', label: 'Follow-ups' }
]

/** The CRM hub: Contacts (Phase 1), Deals (Phase 3), and Follow-ups
 *  (Phase 4) as tabs of one screen, rather than separate sidebar items —
 *  they're one feature area. */
export function CrmView(): React.JSX.Element {
  const [tab, setTab] = useState<CrmTab>('contacts')
  const [openDealId, setOpenDealId] = useState<string | null>(null)
  const [openContactId, setOpenContactId] = useState<string | null>(null)
  const { settings } = useAppSettings()

  // The Follow-ups tab is fully hidden when the feature is off in Settings —
  // not just grayed out, per the "off means invisible" rule from Phase 4 Step 1.
  const tabs = settings.crm.staleFollowUpEnabled ? TABS : TABS.filter((t) => t.id !== 'followups')

  const openDealFromDigest = (dealId: string): void => {
    setOpenDealId(dealId)
    setTab('deals')
  }

  const openContactFromDigest = (contactId: string): void => {
    setOpenContactId(contactId)
    setTab('contacts')
  }

  return (
    <div>
      <div className="mb-5 flex items-center gap-1">
        {tabs.map((t) => (
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
      {tab === 'contacts' ? (
        <ContactsView
          initialViewId={openContactId}
          onInitialViewConsumed={() => setOpenContactId(null)}
        />
      ) : tab === 'deals' ? (
        <DealsView
          initialViewDealId={openDealId}
          onInitialViewConsumed={() => setOpenDealId(null)}
        />
      ) : (
        <FollowUpDigest onOpenDeal={openDealFromDigest} onOpenContact={openContactFromDigest} />
      )}
    </div>
  )
}
