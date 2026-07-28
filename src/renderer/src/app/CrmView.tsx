import { useEffect, useRef, useState } from 'react'
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

interface CrmViewProps {
  /** The command palette's "jump to a specific contact/deal" — preselects
   *  that record and switches to its tab on mount. Same one-shot-consume
   *  shape as PastCallsView's initialSelectedId. */
  initialContactId?: string | null
  initialDealId?: string | null
  onInitialSelectionConsumed?: () => void
}

/** The CRM hub: Contacts (Phase 1), Deals (Phase 3), and Follow-ups
 *  (Phase 4) as tabs of one screen, rather than separate sidebar items —
 *  they're one feature area. */
export function CrmView({
  initialContactId = null,
  initialDealId = null,
  onInitialSelectionConsumed
}: CrmViewProps = {}): React.JSX.Element {
  const [tab, setTab] = useState<CrmTab>(initialDealId ? 'deals' : 'contacts')
  const [openDealId, setOpenDealId] = useState<string | null>(initialDealId)
  const [openContactId, setOpenContactId] = useState<string | null>(initialContactId)

  const consumedRef = useRef(false)
  useEffect(() => {
    if ((initialDealId || initialContactId) && !consumedRef.current) {
      consumedRef.current = true
      onInitialSelectionConsumed?.()
    }
  }, [initialDealId, initialContactId, onInitialSelectionConsumed])

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
