import { useEffect, useRef } from 'react'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import type { CallSegment } from '@renderer/features/calls/types'

interface TranscriptViewProps {
  segments: CallSegment[]
  interimText: string
}

/** Scrollable live transcript: speaker-labeled finalized turns + faint interim. */
export function TranscriptView({ segments, interimText }: TranscriptViewProps): React.JSX.Element {
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
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-faint">Your words will appear here as you speak…</p>
        </div>
      ) : (
        <SpeakerTranscript segments={segments} interimText={interimText} />
      )}
    </div>
  )
}
