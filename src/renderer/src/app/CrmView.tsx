import { useState } from 'react'
import { PageHeader } from '@renderer/components/PageHeader'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { ContactsView } from '@renderer/features/contacts/ContactsView'
import { DealsView } from '@renderer/features/deals/DealsView'
import { FollowUpDigest } from '@renderer/features/deals/FollowUpDigest'
import { useConsumeId } from './useConsumeId'

type CrmTab = 'contacts' | 'deals' | 'followups'

const TABS: { id: CrmTab; label: string }[] = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'deals', label: 'Deals' },
  { id: 'followups', label: 'Follow-ups' }
]

interface CrmViewProps {
  /** The command palette's "jump to a specific contact/deal" — preselects
   *  that record and switches to its tab. Consumed id-keyed (BUG-289), the
   *  same shape as PastCallsView's initialSelectedId: a REPEAT of the same
   *  id applies once, a DIFFERENT id always applies, whether or not this
   *  component happens to remount in between. */
  initialContactId?: string | null
  initialDealId?: string | null
  onInitialSelectionConsumed?: () => void
  /** BUG-286 — bumped when the sidebar asks this already-active screen to go
   *  back to its list; forwarded to whichever tab owns a detail view. */
  stepOutToken?: number
}

/** The CRM hub: Contacts (Phase 1), Deals (Phase 3), and Follow-ups
 *  (Phase 4) as tabs of one screen, rather than separate sidebar items —
 *  they're one feature area. */
export function CrmView({
  initialContactId = null,
  initialDealId = null,
  onInitialSelectionConsumed,
  stepOutToken
}: CrmViewProps = {}): React.JSX.Element {
  const [tab, setTab] = useState<CrmTab>(initialDealId ? 'deals' : 'contacts')
  const [openDealId, setOpenDealId] = useState<string | null>(initialDealId)
  const [openContactId, setOpenContactId] = useState<string | null>(initialContactId)

  // BUG-289 — `openDealId`/`openContactId`/`tab` above were seeded from
  // props exactly once (a `useState` initializer). That was invisible while
  // a rep's second RECENT/palette click always meant leaving CRM first (a
  // genuine `active` change remounts this component fresh); it became a
  // real bug once a second click could target CRM WHILE ALREADY ON IT —
  // nothing remounts, so the new id never reached `openDealId`/
  // `openContactId` at all. Two separate useConsumeId calls, so a contact
  // click and a deal click never share one memory of "the last id seen".
  useConsumeId(initialDealId, (id) => {
    setOpenDealId(id)
    setTab('deals')
    onInitialSelectionConsumed?.()
  })
  useConsumeId(initialContactId, (id) => {
    setOpenContactId(id)
    setTab('contacts')
    onInitialSelectionConsumed?.()
  })

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
          stepOutToken={stepOutToken}
        />
      ) : tab === 'deals' ? (
        <DealsView
          initialViewDealId={openDealId}
          onInitialViewConsumed={() => setOpenDealId(null)}
          stepOutToken={stepOutToken}
        />
      ) : (
        <FollowUpDigest onOpenDeal={openDealFromDigest} onOpenContact={openContactFromDigest} />
      )}
    </div>
  )
}
