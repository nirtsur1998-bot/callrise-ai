import { useEffect, useRef, useState } from 'react'
import { X, Phone } from 'lucide-react'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import type { Call } from '@renderer/features/calls/types'

interface ViewCallModalProps {
  callId: string
  callTitle: string
  onClose: () => void
}

/** A read-only transcript peek — the "link to view that call" the review
 *  queue needs, without wiring cross-screen navigation out of Settings. */
export function ViewCallModal({ callId, callTitle, onClose }: ViewCallModalProps): React.JSX.Element {
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="View call"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft">
              <Phone className="h-4 w-4 text-accent" />
            </div>
            <p className="truncate text-sm font-semibold">{callTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!loaded ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : !call ? (
            <p className="text-sm text-muted">This call is no longer available.</p>
          ) : (
            <SpeakerTranscript segments={call.segments} />
          )}
        </div>
      </div>
    </div>
  )
}
