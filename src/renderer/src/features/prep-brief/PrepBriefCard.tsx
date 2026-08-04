import {
  RefreshCw,
  Users,
  TrendingUp,
  History,
  ListChecks,
  ShieldAlert,
  MessageSquare
} from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { Skeleton } from '@renderer/components/Skeleton'
import type { PrepBriefRecord } from '../../../../preload/index.d'

interface PrepBriefCardProps {
  loading: boolean
  record: PrepBriefRecord | null
  error: string | null
  onRegenerate: () => void
}

function Section({
  icon: Icon,
  label,
  children
}: {
  icon: typeof Users
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-elevated text-faint">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</p>
        <div className="mt-0.5 text-[13px] leading-relaxed text-ink">{children}</div>
      </div>
    </div>
  )
}

/** The rich, in-app rendering of the six-section prep brief — a "who am I
 *  about to talk to" cheat sheet for the 30 seconds before a call starts. */
export function PrepBriefCard({
  loading,
  record,
  error,
  onRegenerate
}: PrepBriefCardProps): React.JSX.Element {
  if (loading && !record) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    )
  }

  if (error && !record) {
    return <p className="py-4 text-center text-[13px] text-faint">{error}</p>
  }

  if (!record) {
    return <p className="py-4 text-center text-[13px] text-faint">No brief yet.</p>
  }

  const { brief } = record

  return (
    <div className="space-y-4">
      <Section icon={Users} label="Who you're meeting">
        {brief.whoYoureMeeting || <span className="text-faint">Nothing on record.</span>}
      </Section>
      <Section icon={TrendingUp} label="Deal status">
        {brief.dealStatus || <span className="text-faint">No deal linked.</span>}
      </Section>
      <Section icon={History} label="Last time">
        {brief.lastTime || <span className="text-faint">No prior call on record.</span>}
      </Section>
      <Section icon={ListChecks} label="Open commitments">
        {brief.openCommitments.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {brief.openCommitments.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : (
          <span className="text-faint">None on record.</span>
        )}
      </Section>
      <Section icon={ShieldAlert} label="Likely objections">
        {brief.likelyObjections.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4">
            {brief.likelyObjections.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        ) : (
          <span className="text-faint">Nothing to ground a guess in.</span>
        )}
      </Section>
      <Section icon={MessageSquare} label="Openers">
        {brief.openers.length > 0 ? (
          <ol className="list-decimal space-y-1 pl-4">
            {brief.openers.map((o, i) => (
              <li key={i}>&ldquo;{o}&rdquo;</li>
            ))}
          </ol>
        ) : (
          <span className="text-faint">—</span>
        )}
      </Section>

      <div className="flex items-center justify-between border-t border-line-soft pt-3">
        <p className="text-[11px] text-faint">
          {record.savedAt ? `Generated ${new Date(brief.generatedAt).toLocaleString()}` : ''}
        </p>
        <Button
          variant="secondary"
          size="sm"
          icon={RefreshCw}
          onClick={onRegenerate}
          disabled={loading}
        >
          {loading ? 'Regenerating…' : 'Regenerate'}
        </Button>
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}
