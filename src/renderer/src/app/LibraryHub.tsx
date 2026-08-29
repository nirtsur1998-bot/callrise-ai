import { useState } from 'react'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { Card } from '@renderer/components/Card'
import { EmptyState } from '@renderer/components/EmptyState'
import { MessageSquareWarning } from 'lucide-react'
import { KnowledgeView } from '@renderer/features/knowledge/KnowledgeView'
import { BattlecardsView } from '@renderer/features/live/battlecards/BattlecardsView'
import { ObjectionHeatmap } from '@renderer/features/objection-library/ObjectionHeatmap'
import { ReviewQueueView } from '@renderer/features/objection-library/ReviewQueueView'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'

type LibraryTab = 'knowledge' | 'battlecards' | 'objections'

const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'battlecards', label: 'Battlecards' },
  { id: 'objections', label: 'Objections' }
]

/** The heatmap + review queue, graduated out of Settings -> Objection
 *  Library — same two components Settings already composes (identical
 *  headings/copy), just given a first-class home. The mining ON/OFF toggle
 *  and the one-time "scan my past calls" trigger deliberately STAY in
 *  Settings (a feature flag and a batch action are settings-shaped, same
 *  established split as Sales Brain's toggle vs. its Memory Center content).
 *
 *  Applies the audit's own "visible-off state" recommendation for real: with
 *  mining off, an empty heatmap/queue would read as "nothing's happened
 *  yet" when the true reason is "this is switched off" — a different fact
 *  needing a different action. */
function ObjectionsTab(): React.JSX.Element {
  const { settings } = useAppSettings()
  if (!settings.objectionMining.enabled) {
    return (
      <div className="flex h-full items-center justify-center py-12">
        <EmptyState
          icon={MessageSquareWarning}
          title="Objection mining is switched off"
          titleAs="h2"
          description="Turn on “Learn objection responses from my calls” in Settings → AI & coaching → Objection Library to start building this list."
        />
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card>
        <h3 className="mb-1 text-sm font-semibold">Objection heatmap</h3>
        <p className="mb-4 text-[12px] text-muted">
          Which objection types come up most often across your pending review-queue candidates.
        </p>
        <ObjectionHeatmap />
      </Card>
      <Card>
        <h3 className="mb-1 text-sm font-semibold">Review queue</h3>
        <p className="mb-4 text-[12px] text-muted">
          Suggestions mined from your calls, waiting for your decision. Nothing here is a real
          script yet — approve, edit then approve, or reject each one.
        </p>
        <ReviewQueueView />
      </Card>
    </div>
  )
}

/** M31 Stage 2 — Knowledge, Battlecards (new), and Objections as tabs of one
 *  "Library" screen: the rep's own sales material, what's already listening
 *  live, and what it's learned — one place for "what does this app know." */
export function LibraryHub(): React.JSX.Element {
  const [tab, setTab] = useState<LibraryTab>('knowledge')

  return (
    <div>
      <SegmentedControl options={TABS} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'knowledge' ? (
        <KnowledgeView />
      ) : tab === 'battlecards' ? (
        <BattlecardsView />
      ) : (
        <ObjectionsTab />
      )}
    </div>
  )
}
