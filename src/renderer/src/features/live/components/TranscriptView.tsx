import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import type { CallSegment } from '@renderer/features/calls/types'
import type { SpeakerIdentities } from '@renderer/features/coaching/meta'

interface TranscriptViewProps {
  segments: CallSegment[]
  interimText: string
  repSpeaker?: number | null
  /** Session is paused — swaps the empty-state copy + dots for a "Paused" one. */
  paused?: boolean
  /** M19 Task 2 step 5 — the buyer's name, once self-intro extraction has
   *  resolved it live. No calendar/contact resolution here (that needs a
   *  saved callId) — self-intro is the only source that can name someone
   *  DURING a call in progress. */
  identities?: SpeakerIdentities
}

/** Scrollable live transcript: speaker-labeled finalized turns + faint interim. */
export function TranscriptView({
  segments,
  interimText,
  repSpeaker = null,
  paused = false,
  identities
}: TranscriptViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // Mirrors stickToBottom into render state — only to decide whether the
  // "jump to latest" affordance shows, so it doesn't need to fire on every
  // scroll pixel the way the ref-based auto-scroll check does.
  const [caughtUp, setCaughtUp] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [segments, interimText])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stickToBottom.current = stuck
    setCaughtUp((prev) => (prev === stuck ? prev : stuck))
  }

  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = true
    setCaughtUp(true)
    el.scrollTop = el.scrollHeight
  }

  const isEmpty = segments.length === 0 && !interimText

  return (
    <div className="relative flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto rounded-2xl border border-line-soft bg-surface px-7 py-6"
      >
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5">
            <p className="text-sm text-faint">
              {paused
                ? 'Paused — nothing is being captured'
                : 'Your words will appear here as you speak…'}
            </p>
            {!paused && (
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            )}
          </div>
        ) : (
          <SpeakerTranscript
            segments={segments}
            interimText={interimText}
            repSpeaker={repSpeaker}
            identities={identities}
          />
        )}
      </div>
      {!caughtUp && !isEmpty && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="no-drag press absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs font-medium text-ink shadow-md transition hover:brightness-110"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  )
}
