import { PageHeader } from '@renderer/components/PageHeader'
import { Card } from '@renderer/components/Card'
import { Badge } from '@renderer/components/Badge'
import { STARTER_TRIGGERS } from './library'
import type { BattlecardCategory } from './match'

const CATEGORY_LABEL: Record<BattlecardCategory, string> = {
  pricing: 'Pricing',
  objection: 'Objection',
  process: 'Process',
  competitor: 'Competition'
}

const CATEGORY_ORDER: BattlecardCategory[] = ['pricing', 'objection', 'process', 'competitor']

/** M31 Stage 2 — a real browser for the 30 built-in battlecards, closing
 *  one of the audit's flagged "undiscoverable feature" findings: these
 *  already fire live during every call (features/live/battlecards/match.ts
 *  watches the rolling transcript for these exact phrases), but until now
 *  there was no way to see, or even know about, a single one of them.
 *
 *  Deliberately read-only for this landing — the STARTER_TRIGGERS list is
 *  curated, shipped content, not user data, so there's nothing to edit here
 *  yet. Custom trackers (the AI-generated, per-user version of the same
 *  idea) still live at Settings -> Coaching; consolidating both into one
 *  create+browse surface here is real follow-up work, not a same-day regroup
 *  — noted rather than rushed. */
export function BattlecardsView(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Battlecards"
        count={`${STARTER_TRIGGERS.length} built in`}
        subtitle="What's already listening on every live call — the phrase on the left fires the response on the right, automatically, no setup needed. Add your own in Settings → Coaching → Custom trackers."
      />
      <div className="space-y-6">
        {CATEGORY_ORDER.map((category) => {
          const cards = STARTER_TRIGGERS.filter((t) => t.card.category === category)
          if (cards.length === 0) return null
          return (
            <section key={category}>
              <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
                {CATEGORY_LABEL[category]}
              </h3>
              <div className="space-y-2">
                {cards.map((trigger) => (
                  <Card key={trigger.id}>
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone="neutral">{trigger.card.label}</Badge>
                    </div>
                    <p className="text-[13px] text-ink">{trigger.card.say}</p>
                    <p className="mt-1.5 text-[11px] text-faint">
                      Fires on: {trigger.patterns.map((p) => `"${p}"`).join(', ')}
                    </p>
                  </Card>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
