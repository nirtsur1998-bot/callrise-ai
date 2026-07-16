import { useId, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Badge, type BadgeTone } from '@renderer/components/Badge'
import { TONE_TEXT, type Tone } from '@renderer/features/coaching/meta'
import { useKnowledgePreview } from './useKnowledgePreview'

const LEVEL_TONE: Record<string, Tone> = { ok: 'good', large: 'mid', over: 'low' }

const LEVEL_BADGE_TONE: Record<string, BadgeTone> = {
  ok: 'positive',
  large: 'warning',
  over: 'danger'
}
const LEVEL_BADGE_LABEL: Record<string, string> = {
  ok: 'Good size',
  large: 'Getting large',
  over: 'Too large'
}

const LEVEL_MESSAGE: Record<string, string> = {
  ok: 'Good size — comfortably fits the AI context on every live cue.',
  large:
    'Getting large. Summaries and coaching still use all of it, but live cues only include the first ~4,000 characters — entries past that are left out of in-call suggestions. Trimming keeps everything included, fast, and cheap.',
  over: 'Too large for the simple approach. Trim it down, or this is the point where a future upgrade (retrieving only the relevant bits instead of sending everything) becomes worth building.'
}

/** Shows exactly what text the AI would be given as context, and a rough
 *  size estimate so the knowledge base doesn't quietly grow past what's
 *  efficient to resend on every live cue. */
export function ContextSizePanel({ refreshKey }: { refreshKey: unknown }): React.JSX.Element {
  const { preview, loading } = useKnowledgePreview(refreshKey)
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()

  if (loading && !preview) {
    return (
      <div className="mb-5 rounded-xl border border-line-soft bg-surface px-4 py-3 text-[13px] text-faint">
        Checking size…
      </div>
    )
  }
  if (!preview) return <></>

  const tone = LEVEL_TONE[preview.level] ?? 'neutral'
  const empty = preview.charCount === 0

  return (
    <div className="mb-5 rounded-xl border border-line-soft bg-surface px-4 py-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
            AI context size:{' '}
            <span className={TONE_TEXT[tone]}>
              <span className="tabular-nums">{preview.charCount.toLocaleString()}</span> chars · ~
              <span className="tabular-nums">{preview.estimatedTokens.toLocaleString()}</span>{' '}
              tokens
            </span>
            {!empty && (
              <Badge tone={LEVEL_BADGE_TONE[preview.level] ?? 'neutral'}>
                {LEVEL_BADGE_LABEL[preview.level] ?? preview.level}
              </Badge>
            )}
          </p>
          {empty && (
            <p className="mt-0.5 text-[12px] text-muted">
              Nothing yet — add scripts, product info, or a playbook section above.
            </p>
          )}
        </div>
        {!empty &&
          (expanded ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-faint" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-faint" />
          ))}
      </button>

      {expanded && !empty && (
        <div id={contentId}>
          <p className="mt-2 text-[12px] text-muted">{LEVEL_MESSAGE[preview.level]}</p>
          <pre
            className={cn(
              'mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-canvas px-3 py-2.5 text-[12px] leading-relaxed text-muted'
            )}
          >
            {preview.text}
          </pre>
        </div>
      )}
    </div>
  )
}
