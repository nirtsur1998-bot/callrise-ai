import { useState } from 'react'
import { PageHeader } from '@renderer/components/PageHeader'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { ContactsView } from '@renderer/features/contacts/ContactsView'
import { DealsView } from '@renderer/features/deals/DealsView'
import { FollowUpDigest } from '@renderer/features/deals/FollowUpDigest'

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

  // The Follow-ups tab always shows — it now covers risk flags, open linked
  // tasks, and this week's meetings, none of which depend on the cadence
  // (stale-after-days) setting. FollowUpDigest itself still respects that
  // setting for its cadence-based rows.
  const tabs = TABS

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
      <PageHeader
        title="CRM"
        actions={<SegmentedControl options={tabs} value={tab} onChange={setTab} />}
      />
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
