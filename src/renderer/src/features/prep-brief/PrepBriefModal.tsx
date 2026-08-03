import { useMemo } from 'react'
import { X, Sparkles } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { PrepBriefCard } from './PrepBriefCard'
import { usePrepBrief } from './usePrepBrief'
import type { PrepBriefAttendee } from '../../../../preload/index.d'

export interface PrepBriefMeeting {
  eventId: string
  title: string
  startIso: string
  attendees: PrepBriefAttendee[]
  contactId?: string
  dealId?: string
}

interface PrepBriefModalProps {
  meeting: PrepBriefMeeting
  onClose: () => void
}

/** Opened from three places: the Calendar event dialog's "Prep brief" button,
 *  a callrise://meeting/<id> deep link (a meeting_starting alert), and Live
 *  Calls' "show brief again" affordance right as a call starts. Same modal,
 *  same cached-or-generated brief either way — the meeting's identity
 *  (eventId) is what the cache keys on, not which surface opened it. */
export function PrepBriefModal({ meeting, onClose }: PrepBriefModalProps): React.JSX.Element {
  const input = useMemo(
    () => ({
      eventId: meeting.eventId,
      title: meeting.title,
      startIso: meeting.startIso,
      attendees: meeting.attendees,
      contactId: meeting.contactId,
      dealId: meeting.dealId
    }),
    [
      meeting.eventId,
      meeting.title,
      meeting.startIso,
      meeting.attendees,
      meeting.contactId,
      meeting.dealId
    ]
  )
  const { loading, record, error, regenerate } = usePrepBrief(input)

  return (
    <Modal onClose={onClose} title="Prep brief" size="lg" className="flex max-h-[85vh] flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <div>
            <h2 className="text-sm font-semibold">Prep brief</h2>
            <p className="text-[12px] text-faint">{meeting.title}</p>
          </div>
        </div>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <PrepBriefCard loading={loading} record={record} error={error} onRegenerate={regenerate} />
      </div>
    </Modal>
  )
}
