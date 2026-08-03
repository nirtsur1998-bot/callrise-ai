import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Eye, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { speakerLabel } from '@renderer/features/coaching/meta'
import type { Call } from './types'

interface PracticeModeProps {
  call: Call
  onExit: () => void
}

/**
 * A distraction-free rehearsal flow — no audio, no timing pressure. Steps
 * through the call's turns one at a time: the buyer's lines show directly,
 * so the rep can read them and think through (or say aloud) their own
 * response before clicking "Reveal" to compare it against what they actually
 * said on the call, then move on with Previous/Next.
 */
export function PracticeMode({ call, onExit }: PracticeModeProps): React.JSX.Element {
  const repSpeaker = call.coaching?.metrics.repSpeaker ?? null
  const speakerCount = useMemo(
    () => new Set(call.segments.map((s) => s.speaker)).size,
    [call.segments]
  )
  const turns = call.segments
  const total = turns.length
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)

  const turn = total > 0 ? turns[Math.min(index, total - 1)] : null
  // Prefer the turn's own recorded attribution over the whole-call number,
  // matching SpeakerTranscript. A raw number only means something inside one
  // speaker-label epoch.
  const isRep = turn !== null && (turn.role ? turn.role === 'rep' : turn.speaker === repSpeaker)

  const goTo = (next: number): void => {
    setIndex(Math.max(0, Math.min(total - 1, next)))
    setRevealed(false)
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Practice mode</h2>
          <p className="truncate text-[13px] text-muted">{call.title}</p>
        </div>
        <IconButton icon={X} label="Exit practice mode" onClick={onExit} />
      </div>

      {turn === null ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm italic text-faint">This call has no transcript to practice.</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <p className="mb-3 text-center text-[12px] font-medium text-faint">
            Turn {index + 1} of {total}
          </p>

          <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-line-soft bg-surface px-8 py-10 text-center">
            <span
              className={cn(
                'mb-3 text-xs font-semibold uppercase tracking-wide',
                isRep ? 'text-accent' : 'text-muted'
              )}
            >
              {speakerLabel(turn.speaker, repSpeaker, speakerCount, turn.role)}
            </span>
            {isRep && !revealed ? (
              <>
                <p className="mb-6 max-w-md select-none text-[17px] leading-[1.7] text-faint blur-sm">
                  {turn.text}
                </p>
                <Button icon={Eye} onClick={() => setRevealed(true)}>
                  Reveal what you said
                </Button>
              </>
            ) : (
              <p className="max-w-md text-[17px] leading-[1.7] text-ink">{turn.text}</p>
            )}
          </div>

          <div className="mt-5 flex items-center justify-between">
            <Button
              variant="secondary"
              icon={ChevronLeft}
              disabled={index === 0}
              onClick={() => goTo(index - 1)}
            >
              Previous
            </Button>
            <Button
              icon={ChevronRight}
              iconPosition="right"
              disabled={index === total - 1}
              onClick={() => goTo(index + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
