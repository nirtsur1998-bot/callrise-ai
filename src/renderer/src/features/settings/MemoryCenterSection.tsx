import { useEffect, useMemo, useState } from 'react'
import { Pin, PinOff, Pencil, Trash2, Check, X as XIcon, History, TriangleAlert } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { IconButton } from '@renderer/components/IconButton'
import type { Memory, MemoryChangelogEntry, TemporalBackfillRecord } from '../../../../preload/index.d'
import { Brain } from 'lucide-react'
import { EmptyState } from '@renderer/components/EmptyState'
import { useAppSettings } from './useAppSettings'

type ScopeFilter = 'rep' | 'business' | 'client'

const SCOPE_LABEL: Record<ScopeFilter, string> = {
  rep: 'About you',
  business: 'Your business',
  client: 'Per client'
}

const STATUS_LABEL: Record<Memory['status'], string> = {
  active: 'Trusted fact',
  hypothesis: 'Still a hunch',
  invalidated: 'Replaced',
  archived: 'Forgotten'
}

const STATUS_COLOR: Record<Memory['status'], string> = {
  active: 'bg-success-soft text-success',
  hypothesis: 'bg-elevated text-faint',
  invalidated: 'bg-danger-soft text-danger',
  archived: 'bg-elevated text-faint'
}

function matchesScope(scope: string, filter: ScopeFilter): boolean {
  if (filter === 'client') return scope.startsWith('client:')
  return scope === filter
}

const fmtDay = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const fmtWhen = (iso: string, source: Memory['validFromSource']): string =>
  source === 'approx' ? `around ${fmtDay(iso)}` : fmtDay(iso)

/**
 * M36 Stage 3 item 5, step 5 — the validity window in the user's words. The
 * founder: "a fact that quietly disappears from view because it was
 * superseded would read as data loss … 'was true from March to July' is
 * information I want, not clutter." So a superseded fact keeps its row and
 * says its window; a live fact says since when; an approximate date says
 * "around" and never pretends to a precise day. null for an undated row (a
 * store the backfill has not reached), so nothing is claimed that is not
 * known.
 */
export function validityText(memory: Memory): string | null {
  if (!memory.validFrom && !memory.validUntil) return null
  if (memory.validUntil) {
    const until = fmtWhen(memory.validUntil, memory.validUntilSource)
    return memory.validFrom ? `Was true ${fmtWhen(memory.validFrom, memory.validFromSource)} – ${until}` : `Was true until ${until}`
  }
  return `True since ${fmtWhen(memory.validFrom!, memory.validFromSource)}`
}

/** The header line built from the backfill's record — the counts the founder
 *  asked to see rather than find in a log. */
export function temporalSummaryText(record: TemporalBackfillRecord | null): string | null {
  if (!record) return null
  if (record.status === 'skipped') return `Dating of facts was skipped at last launch (${record.reason}) and runs at the next one.`
  const real = record.validFrom.call + record.datedBefore
  const parts = [
    `${real} dated from the call they came from`,
    ...(record.validFrom.stated ? [`${record.validFrom.stated} from your own words`] : []),
    `${record.validFrom.approx} only by when they were learned (approximate)`
  ]
  return `${record.total} facts: ${parts.join(', ')}.`
}

function MemoryRow({
  memory,
  onSaved
}: {
  memory: Memory
  onSaved: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.statement)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || text === memory.statement) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await window.api.salesBrain.memories.update(memory.id, text)
      onSaved()
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.salesBrain.memories.setPinned(memory.id, !memory.pinned)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`Delete "${memory.statement}"? This can't be undone.`)) return
    setBusy(true)
    try {
      await window.api.salesBrain.memories.delete(memory.id)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-3 border-b border-line-soft py-3 last:border-0">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              autoFocus
              className="w-full resize-none rounded-lg border border-line-soft bg-elevated px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <div className="flex gap-2">
              <Button size="sm" icon={Check} onClick={() => void save()} disabled={busy}>
                Save
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={XIcon}
                onClick={() => {
                  setDraft(memory.statement)
                  setEditing(false)
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-ink">{memory.statement}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLOR[memory.status]}`}>
                {STATUS_LABEL[memory.status]}
              </span>
              <span className="text-[10px] text-faint">{Math.round(memory.confidence * 100)}% confidence</span>
              <span className="text-[10px] text-faint">·</span>
              <span className="text-[10px] text-faint">{memory.category}</span>
              {memory.pinned && <Pin className="h-3 w-3 text-accent" />}
            </div>
            {validityText(memory) && (
              // a superseded fact's window is the information, not clutter —
              // it stays visible and reads differently from a live fact's
              <p
                data-testid="memory-validity"
                className={`mt-1 text-[11px] ${memory.validUntil ? 'text-danger' : 'text-faint'}`}
              >
                {validityText(memory)}
              </p>
            )}
          </>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={memory.pinned ? PinOff : Pin}
            label={memory.pinned ? 'Unpin' : 'Pin'}
            onClick={() => void togglePin()}
            disabled={busy}
          />
          <IconButton icon={Pencil} label="Edit" onClick={() => setEditing(true)} disabled={busy} />
          <IconButton icon={Trash2} label="Delete" onClick={() => void remove()} disabled={busy} />
        </div>
      )}
    </div>
  )
}

/** M25 Phase 5 — spec section 4's Memory Center: "Browse every active
 *  memory grouped by scope... Edit / Delete / Pin," plus the changelog and
 *  "Forget everything." Deliberately shows every status, not just
 *  'active' — a rep wanting to see "what's still a hunch" is exactly the
 *  transparency this whole section exists for. */
export function MemoryCenterSection(): React.JSX.Element {
  // Read only — this page never toggles Sales Brain, it just has to stop
  // claiming facts will appear when the feature that produces them is off.
  const { settings } = useAppSettings()
  const salesBrainOn = settings.salesBrain.enabled
  const [scope, setScope] = useState<ScopeFilter>('rep')
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [showChangelog, setShowChangelog] = useState(false)
  const [changelog, setChangelog] = useState<MemoryChangelogEntry[]>([])
  const [forgetting, setForgetting] = useState(false)
  // M36 Stage 3 item 5 — what the backfill did to the store, shown here
  // because this page is where the user checks what the app thinks it knows
  const [temporal, setTemporal] = useState<TemporalBackfillRecord | null>(null)

  const refresh = (): void => {
    void window.api.salesBrain.memories.list().then(setMemories)
    void window.api.salesBrain.memories.temporalRecord?.().then(setTemporal).catch(() => setTemporal(null))
  }

  useEffect(refresh, [])

  useEffect(() => {
    if (showChangelog) void window.api.salesBrain.memories.changelog().then(setChangelog)
  }, [showChangelog])

  const filtered = useMemo(
    () => (memories ?? []).filter((m) => matchesScope(m.scope, scope)),
    [memories, scope]
  )

  // the clock is read once, when the page opens — never during a render
  // (react-hooks/purity); "this week" is relative to opening the page
  const [openedAt] = useState(() => Date.now())
  const weeklyCount = useMemo(() => {
    const weekAgo = openedAt - 7 * 24 * 60 * 60 * 1000
    return (memories ?? []).filter((m) => new Date(m.createdAt).getTime() >= weekAgo).length
  }, [memories, openedAt])

  const forgetEverything = async (): Promise<void> => {
    if (
      !window.confirm(
        'Forget EVERYTHING Sales Brain has learned? This deletes every memory across every scope — your calls, contacts, and deals themselves are untouched, only what Sales Brain learned from them. This cannot be undone.'
      )
    ) {
      return
    }
    setForgetting(true)
    try {
      await window.api.salesBrain.memories.forgetEverything()
      refresh()
    } finally {
      setForgetting(false)
    }
  }

  return (
    <>
      {weeklyCount > 0 && (
        <Card className="mb-5">
          <p className="text-[13px] text-ink">
            <strong>{weeklyCount}</strong> new thing{weeklyCount === 1 ? '' : 's'} learned this week.
          </p>
        </Card>
      )}

      {temporalSummaryText(temporal) && (
        <Card className="mb-5">
          <p data-testid="memory-temporal-summary" className="text-[12px] text-faint">
            <span className="font-medium text-ink">When facts were true. </span>
            {temporalSummaryText(temporal)} A replaced fact keeps its row and says the period it covered; an
            approximate date says “around”.
          </p>
        </Card>
      )}

      <Card className="mb-5">
        <div className="mb-3 flex items-center justify-between">
          <SegmentedControl
            options={(['rep', 'business', 'client'] as ScopeFilter[]).map((s) => ({ id: s, label: SCOPE_LABEL[s] }))}
            value={scope}
            onChange={setScope}
          />
          <Button variant="secondary" size="sm" icon={History} onClick={() => setShowChangelog((v) => !v)}>
            {showChangelog ? 'Hide history' : 'History'}
          </Button>
        </div>

        {showChangelog ? (
          <div className="max-h-96 overflow-y-auto">
            {changelog.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-faint">Nothing yet.</p>
            ) : (
              changelog.map((entry, i) => (
                <div key={i} className="border-b border-line-soft py-2 text-[12px] last:border-0">
                  <span className="text-faint">
                    {entry.kind === 'created' ? 'Learned' : entry.kind === 'reinforced' ? 'Reconfirmed' : 'Replaced'}{' '}
                    · {new Date(entry.at).toLocaleDateString()}
                  </span>
                  <p className="mt-0.5 text-ink">{entry.statement}</p>
                </div>
              ))
            )}
          </div>
        ) : !memories ? (
          <p className="py-4 text-center text-[13px] text-faint">Loading…</p>
        ) : filtered.length === 0 ? (
          // M31 Stage 3 — the audit's headline example of a dishonest empty
          // state. With Sales Brain OFF this said "facts will show up as
          // calls happen", which is not merely unhelpful: it is FALSE.
          // Nothing will ever show up, and it prescribes work (make more
          // calls) that cannot possibly help. Two states that looked
          // identical and pointed at completely different actions.
          <EmptyState
            compact
            icon={Brain}
            title={
              salesBrainOn
                ? `No ${SCOPE_LABEL[scope].toLowerCase()} facts yet`
                : 'Sales Brain is switched off'
            }
            description={
              salesBrainOn
                ? `${SCOPE_LABEL[scope]} facts appear here as calls are analysed.`
                : undefined
            }
            reason={
              salesBrainOn
                ? { kind: 'empty' }
                : {
                    kind: 'off',
                    settingsPage: 'sales-brain',
                    what: 'Sales Brain learns who you are, how you sell, your business and each client, so every AI feature gets sharper over time.',
                    cost: 'Runs entirely on your own device. Nothing is sent anywhere.',
                    actionLabel: 'Turn on Sales Brain'
                  }
            }
          />
        ) : (
          <div>
            {filtered.map((m) => (
              <MemoryRow key={m.id} memory={m} onSaved={refresh} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Forget everything</h3>
            <p className="text-[12px] text-faint">
              Deletes every memory across every scope. Your calls, contacts, and deals are untouched.
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={() => void forgetEverything()} disabled={forgetting}>
            {forgetting ? 'Forgetting…' : 'Forget everything'}
          </Button>
        </div>
      </Card>
    </>
  )
}
