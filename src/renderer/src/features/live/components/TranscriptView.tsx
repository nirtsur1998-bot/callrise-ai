import { useEffect, useRef } from 'react'

interface TranscriptViewProps {
  finalText: string
  interimText: string
}

/** Scrollable transcript: solid finalized text + faint live interim text. */
export function TranscriptView({
  finalText,
  interimText
}: TranscriptViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [finalText, interimText])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    // Re-enable auto-scroll only when the user is near the bottom.
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const isEmpty = !finalText && !interimText

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
        <p className="text-[19px] leading-[1.7] tracking-[-0.01em]">
          <span className="text-ink">{finalText}</span>
          {finalText && interimText ? ' ' : ''}
          <span className="text-faint">{interimText}</span>
        </p>
      )}
    </div>
  )
}
