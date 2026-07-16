import {
  PhoneCall,
  History,
  Clock,
  ListChecks,
  ArrowRight,
  ArrowUpRight,
  Sparkles
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { EmptyState } from '@renderer/components/EmptyState'
import { Skeleton, SkeletonRows } from '@renderer/components/Skeleton'
import { Badge } from '@renderer/components/Badge'
import { AudioSourcesCard } from '@renderer/features/audio/AudioSourcesCard'
import { NoiseCancellationCard } from '@renderer/features/audio/NoiseCancellationCard'
import type { NavId } from '@renderer/features/navigation/nav-items'
import { useCalls } from '@renderer/features/calls/useCalls'
import { useTasks } from '@renderer/features/tasks/useTasks'
import { formatDate } from '@renderer/features/calls/format'
import { computeHomeStats, formatDuration } from './stats'
import { overallTier, TONE_TO_BADGE } from '@renderer/features/coaching/meta'

/** Time-of-day greeting so Home feels personal rather than a static banner. */
function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function HomeView({
  userName,
  onNavigate
}: {
  userName: string
  onNavigate: (id: NavId) => void
}): React.JSX.Element {
  const { calls, loading: callsLoading } = useCalls()
  const { tasks, loading: tasksLoading } = useTasks()
  const stats = computeHomeStats(calls, tasks)
  const recentCalls = [...calls]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 4)

  const dataLoading = callsLoading || tasksLoading
  const STATS: { label: string; value: string; icon: LucideIcon; nav?: NavId }[] = [
    {
      label: 'Calls today',
      value: String(stats.callsToday),
      icon: PhoneCall,
      nav: 'past-calls'
    },
    {
      label: 'Talk time',
      value: formatDuration(stats.talkTimeTodayMs),
      icon: Clock
    },
    { label: 'Tasks due', value: String(stats.tasksDue), icon: ListChecks, nav: 'tasks' }
  ]

  return (
    <div className="mx-auto max-w-3xl">
      {/* Personal greeting */}
      <header className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight">
          {greeting()}, {userName}
        </h2>
        <p className="mt-1.5 text-sm text-muted">
          Here&rsquo;s your desk. Start a call, or pick up where you left off.
        </p>
      </header>

      {/* Primary action */}
      <button
        type="button"
        onClick={() => onNavigate('live-calls')}
        className="lift group mb-5 flex w-full items-center justify-between gap-4 rounded-2xl border border-line-soft bg-elevated p-5 text-left shadow-card"
      >
        <div className="flex items-center gap-4">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand shadow-sm">
            <PhoneCall className="h-5 w-5 text-white" strokeWidth={2} />
          </div>
          <div>
            <p className="font-medium">Start a live call</p>
            <p className="text-[13px] text-muted">Real-time transcription &amp; coaching</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition group-hover:brightness-110">
          Go live <ArrowRight className="h-4 w-4" />
        </span>
      </button>

      {/* Stat row */}
      <div className="mb-5 grid grid-cols-3 gap-4">
        {STATS.map((stat) => {
          const Icon = stat.icon
          const clickable = Boolean(stat.nav)
          const body = (
            <>
              {clickable && (
                <ArrowUpRight className="absolute right-3 top-3 h-3.5 w-3.5 text-faint" />
              )}
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[13px] text-muted">{stat.label}</p>
                <Icon className="h-4 w-4 text-faint" strokeWidth={2} />
              </div>
              {dataLoading ? (
                <Skeleton className="h-7 w-12" />
              ) : (
                <p className="text-2xl font-semibold tracking-tight tabular-nums">{stat.value}</p>
              )}
            </>
          )
          return clickable ? (
            <button
              key={stat.label}
              type="button"
              onClick={() => onNavigate(stat.nav as NavId)}
              className="lift press relative rounded-2xl border border-line-soft bg-surface p-5 text-left shadow-card"
            >
              {body}
            </button>
          ) : (
            <Card key={stat.label} className="relative">
              {body}
            </Card>
          )
        })}
      </div>

      {/* Recent calls */}
      <Card>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent calls</h3>
          <button
            type="button"
            onClick={() => onNavigate('past-calls')}
            className="flex items-center gap-1 text-[12px] font-medium text-muted transition hover:text-ink"
          >
            View all <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
        {callsLoading ? (
          <div className="pt-3">
            <SkeletonRows rows={3} />
          </div>
        ) : recentCalls.length === 0 ? (
          <EmptyState
            icon={History}
            title="No calls yet"
            description="Your saved calls, summaries, and coaching will show up here after your first live call."
            action={{
              label: 'Start a call',
              onClick: () => onNavigate('live-calls'),
              icon: PhoneCall
            }}
            compact
          />
        ) : (
          <ul className="mt-2 space-y-1.5">
            {recentCalls.map((call) => (
              <li key={call.id}>
                <button
                  type="button"
                  onClick={() => onNavigate('past-calls')}
                  className="press flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-elevated"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{call.title}</p>
                    <p className="mt-0.5 truncate text-[11px] text-faint">
                      {formatDate(call.createdAt)}
                    </p>
                  </div>
                  {call.hasCoaching && call.coachScore !== undefined && (
                    <Badge
                      tone={TONE_TO_BADGE[overallTier(call.coachScore).tone]}
                      title={`Call score ${call.coachScore} of 100`}
                    >
                      <span className="tabular-nums">{call.coachScore}</span>
                    </Badge>
                  )}
                  {call.hasSummary && (
                    <Sparkles
                      className="h-3.5 w-3.5 shrink-0 text-accent"
                      strokeWidth={2}
                      aria-label="AI summary available"
                    />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <h3 className="mb-2 mt-8 text-[11px] font-medium uppercase tracking-wide text-faint">
        Audio setup
      </h3>
      <AudioSourcesCard />
      <NoiseCancellationCard />
    </div>
  )
}
