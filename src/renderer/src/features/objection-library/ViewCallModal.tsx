import { useEffect, useRef, useState } from 'react'
import { X, Phone } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import { SkeletonRows } from '@renderer/components/Skeleton'
import type { Call } from '@renderer/features/calls/types'

interface ViewCallModalProps {
  callId: string
  callTitle: string
  onClose: () => void
}

/** A read-only transcript peek — the "link to view that call" the review
 *  queue needs, without wiring cross-screen navigation out of Settings. */
export function ViewCallModal({
  callId,
  callTitle,
  onClose
}: ViewCallModalProps): React.JSX.Element {
  const [call, setCall] = useState<Call | null>(null)
  const [loaded, setLoaded] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    void window.api.calls.get(callId).then((c) => {
      if (!mountedRef.current) return
      setCall(c)
      setLoaded(true)
    })
  }, [callId])

  return (
    <Modal onClose={onClose} title="View call" size="xl" className="flex max-h-[85vh] flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-line-soft px-6 py-4">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft">
            <Phone className="h-4 w-4 text-accent" />
          </div>
          <p className="truncate text-sm font-semibold">{callTitle}</p>
        </div>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {!loaded ? (
          <SkeletonRows rows={6} />
        ) : !call ? (
          <p className="text-sm text-muted">This call is no longer available.</p>
        ) : (
          <SpeakerTranscript
            segments={call.segments}
            repSpeaker={call.coaching?.metrics.repSpeaker ?? null}
          />
        )}
      </div>
    </Modal>
  )
}
