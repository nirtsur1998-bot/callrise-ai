import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { TONE_TEXT, type Tone } from '@renderer/features/coaching/meta'
import { useKnowledgePreview } from './useKnowledgePreview'

const LEVEL_TONE: Record<string, Tone> = { ok: 'good', large: 'mid', over: 'low' }

const LEVEL_MESSAGE: Record<string, string> = {
  ok: 'Good size — comfortably fits the AI context on every live cue.',
  large:
    'Getting large. Still usable, but live cues resend this on every turn — trimming keeps them fast and cheap.',
  over: 'Too large for the simple approach. Trim it down, or this is the point where a future upgrade (retrieving only the relevant bits instead of sending everything) becomes worth building.'
}

/** Shows exactly what text the AI would be given as context, and a rough
 *  size estimate so the knowledge base doesn't quietly grow past what's
 *  efficient to resend on every live cue. */
export function ContextSizePanel({ refreshKey }: { refreshKey: unknown }): React.JSX.Element {
  const { preview, loading } = useKnowledgePreview(refreshKey)
  const [expanded, setExpanded] = useState(false)

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
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="text-[13px] font-medium">
            AI context size:{' '}
            <span className={TONE_TEXT[tone]}>
              {preview.charCount.toLocaleString()} chars · ~
              {preview.estimatedTokens.toLocaleString()} tokens
            </span>
          </p>
          <p className="mt-0.5 text-[12px] text-muted">
            {empty
              ? 'Nothing yet — add scripts, product info, or a playbook section above.'
              : LEVEL_MESSAGE[preview.level]}
          </p>
        </div>
        {!empty &&
          (expanded ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-faint" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-faint" />
          ))}
      </button>

      {expanded && !empty && (
        <pre
          className={cn(
            'mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-canvas px-3 py-2.5 text-[12px] leading-relaxed text-muted'
          )}
        >
          {preview.text}
        </pre>
      )}
    </div>
  )
}
