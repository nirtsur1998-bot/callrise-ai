import { useEffect, useState } from 'react'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { CoachingView } from '@renderer/features/coaching/CoachingView'
import { AnalyticsView } from '@renderer/features/analytics/AnalyticsView'
import { TeamView } from '@renderer/features/team/TeamView'

type CoachingTab = 'scorecards' | 'performance' | 'trend'

const TABS: { id: CoachingTab; label: string }[] = [
  { id: 'scorecards', label: 'Scorecards' },
  { id: 'performance', label: 'Performance' },
  // Matches the actual page content ("Your Trend" / personal-best + streak,
  // explicitly not a team leaderboard) rather than carrying the old "Team"
  // label's mismatch into the new IA — a small honest fix while already
  // touching this exact spot, not a separate pass.
  { id: 'trend', label: 'Your Trend' }
]

/** M31 Stage 2 — Coaching gains two more tabs: Performance (today's
 *  Analytics) and Your Trend (today's Team). CoachingView, AnalyticsView,
 *  and TeamView are all completely unmodified — including CoachingView's
 *  own existing Coach-2.0-gated "Progress" button, which stays exactly
 *  where it is rather than becoming a 4th sibling tab that would often be
 *  empty (Coach 2.0 defaults off). "Practice" isn't a browsable list
 *  screen (it's entered from a specific call's own page or Coaching Chat),
 *  so it isn't a tab here either — inventing a new "start a practice
 *  session" picker is real feature work, not a regroup, and out of scope
 *  for a navigation-structure milestone. */
/** M31 — the tab a redirected navigation asked for. See OLD_TO_HUB_TAB. */
export interface HubTabProps {
  initialTab?: string | null
  onInitialTabConsumed?: () => void
}

export function CoachingHub({ initialTab, onInitialTabConsumed }: HubTabProps): React.JSX.Element {
  const [tab, setTab] = useState<CoachingTab>((initialTab as CoachingTab) ?? 'scorecards')
  // M31 — a navigation that asked for a specific screen this hub absorbed
  // (Home's "Tasks due" card, a recent-items click, a deep link) arrives
  // with the tab it wanted. Applied once and then released, so it can
  // never fight a tab the user picks afterwards.
  useEffect(() => {
    if (!initialTab) return
    if (TABS.some((t) => t.id === initialTab)) setTab(initialTab as CoachingTab)
    onInitialTabConsumed?.()
  }, [initialTab])

  return (
    <div>
      <SegmentedControl options={TABS} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'scorecards' ? (
        <CoachingView />
      ) : tab === 'performance' ? (
        <AnalyticsView />
      ) : (
        <TeamView />
      )}
    </div>
  )
}
