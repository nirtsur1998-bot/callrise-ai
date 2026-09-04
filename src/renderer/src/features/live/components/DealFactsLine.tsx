import { AlertTriangle } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { formatLiveDealFacts, type LiveDealFacts } from '../dealFacts'

/**
 * M34 3d — one line, two glances.
 *
 *   Proposal · ⚠ high risk · last call 27 Aug: "Send the pricing comparison"
 *
 * Glance 1, any time mid-sentence: stage and risk — two words and a colour,
 * fixed position, never changing during the call. Glance 2, once at the
 * start: when you last spoke and what you said you'd do next, in quotes
 * because it is the rep's own stored note.
 *
 * Renders NOTHING when there are no facts (no matched meeting, no deal, no
 * prior call) — the calendar chip's rule: an absent field never becomes a
 * placeholder. Records only; nothing here is computed live and nothing comes
 * from the outcome gate.
 */
export function DealFactsLine({ facts }: { facts: LiveDealFacts | null }): React.JSX.Element | null {
  if (!facts) return null
  const { parts } = formatLiveDealFacts(facts)
  if (parts.length === 0) return null
  return (
    <p
      className="flex min-w-0 max-w-md items-center gap-1.5 truncate text-[12px] text-muted"
      aria-label={`Deal: ${parts.join(', ')}`}
      title={parts.join(' · ')}
      data-testid="live-deal-facts"
    >
      {facts.stage && <span className="font-medium text-ink">{facts.stage}</span>}
      {facts.risk && (
        <>
          {facts.stage && <span className="text-faint">·</span>}
          <span
            className={cn(
              'inline-flex items-center gap-1 font-medium',
              facts.risk === 'high' ? 'text-danger' : 'text-warning'
            )}
          >
            <AlertTriangle className="h-3 w-3" />
            {facts.risk === 'high' ? 'high risk' : 'medium risk'}
          </span>
        </>
      )}
      {facts.lastCall && (
        <>
          {(facts.stage || facts.risk) && <span className="text-faint">·</span>}
          <span className="truncate">{formatLiveDealFacts(facts).lastCallLabel}</span>
        </>
      )}
    </p>
  )
}
