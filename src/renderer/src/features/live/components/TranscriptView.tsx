import { useEffect, useRef } from 'react'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import type { CallSegment } from '@renderer/features/calls/types'

interface TranscriptViewProps {
  segments: CallSegment[]
  interimText: string
  repSpeaker?: number | null
  /** Session is paused — swaps the empty-state copy + dots for a "Paused" one. */
  paused?: boolean
}

/** Scrollable live transcript: speaker-labeled finalized turns + faint interim. */
export function TranscriptView({
  segments,
  interimText,
  repSpeaker = null,
  paused = false
}: TranscriptViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [segments, interimText])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const isEmpty = segments.length === 0 && !interimText

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto rounded-2xl border border-line-soft bg-surface px-7 py-6"
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
        <SpeakerTranscript segments={segments} interimText={interimText} repSpeaker={repSpeaker} />
      )}
    </div>
  )
}
