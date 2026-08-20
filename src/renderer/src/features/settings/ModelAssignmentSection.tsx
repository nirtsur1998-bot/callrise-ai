import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, Loader2, Sparkles } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { ModelLogo, type ModelBrand } from '@renderer/components/ModelLogo'
import { useAppSettings } from './useAppSettings'
import { ASSISTANT_SECTION_NAME } from '../assistant/config'

type AiResolvedCatalogEntry = Awaited<ReturnType<typeof window.api.aiCatalog.resolve>>[number]
type AiPurpose = Parameters<typeof window.api.aiCatalog.assignPrimaryModel>[0]
type AiFallbackEventView = Awaited<ReturnType<typeof window.api.aiFallback.recentEvents>>[number]
type PurposeHealthView = Awaited<ReturnType<typeof window.api.purposeHealth.getAll>>[AiPurpose]

interface JobConfig {
  purpose: AiPurpose
  title: string
  blurb: string
}

// The 5 jobs the brief exposes in the UI - 'other' (4 existing call sites:
// objection-mining, call-title, crm-notes, deal-risk) intentionally has no
// row here, same as the brief scoped it - it stays on the Default text AI
// provider (API keys page) forever, a clean extension point if ever needed.
const JOBS: JobConfig[] = [
  {
    purpose: 'coaching-cue',
    title: 'Live in-call coaching cues',
    blurb: 'Latency-critical — capped to a 2-model fallback chain so a miss never means dead air.'
  },
  {
    purpose: 'summary',
    title: 'Post-call summary',
    blurb: 'Written after the call ends — has more time to think.'
  },
  {
    purpose: 'scorecard',
    title: 'Coaching scorecard',
    blurb: 'Structured feedback on how the call went.'
  },
  {
    purpose: 'tasks',
    title: 'Task extraction',
    blurb: 'Pulls action items out of the transcript.'
  },
  {
    purpose: 'prep-brief',
    title: 'Pre-meeting prep brief',
    blurb:
      'Benefits from long context — feed it a whole call history. (M19’s prep brief feature itself isn’t built yet; assigning a model here just gets it ready.)'
  },
  {
    purpose: 'deal-tier1',
    title: 'Live Deal Intelligence — fast analysis',
    blurb:
      'Latency-critical, same as live coaching cues — capped to a 2-model fallback chain so a missed nudge never means a stale one.'
  },
  {
    purpose: 'deal-tier2',
    title: 'Live Deal Intelligence — health score',
    blurb:
      'Runs every 2-3 minutes, not per-turn — benefits from a stronger model the same way summaries and scorecards do.'
  },
  {
    purpose: 'coaching-chat',
    title: 'Coaching chat',
    blurb: 'Talking to your coach and practice-mode roleplay — a real conversation, streamed live.'
  },
  {
    purpose: 'memory-extract',
    title: 'Sales Brain — fact extraction',
    blurb: 'Pulls candidate memories out of a call or chat — a small, fixed-shape job, benefits from speed over depth.'
  },
  {
    purpose: 'assistant-chat',
    title: `${ASSISTANT_SECTION_NAME} — your AI assistant`,
    blurb:
      'The main chat with the AI that knows your whole business — streamed live, grounded in your Sales Brain. Benefits from the strongest model you have.'
  }
]

function formatContext(n: number | null): string {
  if (n === null) return 'Varies'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}K`
  return String(n)
}

const LANE_LABEL: Record<'speed' | 'quality', string> = { speed: 'Speed', quality: 'Quality' }
const LANE_CLASS: Record<'speed' | 'quality', string> = {
  speed: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  quality: 'border-sky-500/40 bg-sky-500/10 text-sky-200'
}

function entryStatus(entry: AiResolvedCatalogEntry): { dot: string; label: string } {
  if (!entry.hasKey) return { dot: 'bg-line', label: 'No key' }
  if (!entry.available) return { dot: 'bg-danger', label: 'Unavailable' }
  return { dot: 'bg-emerald-400', label: 'Ready' }
}

function CatalogRow({
  entry,
  selected,
  onSelect
}: {
  entry: AiResolvedCatalogEntry
  selected?: boolean
  onSelect?: () => void
}): React.JSX.Element {
  const status = entryStatus(entry)
  const Wrapper = onSelect ? 'button' : 'div'
  return (
    <Wrapper
      type={onSelect ? 'button' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]',
        onSelect && 'transition hover:bg-elevated',
        selected && 'bg-accent-soft'
      )}
    >
      <ModelLogo brand={entry.brand as ModelBrand} size={22} />
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{entry.displayName}</span>
      <span className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted">
        {entry.providerId}
      </span>
      <span
        className={cn(
          'shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
          LANE_CLASS[entry.lane]
        )}
      >
        {LANE_LABEL[entry.lane]}
      </span>
      <span className="w-12 shrink-0 text-right text-[11px] text-faint">
        {formatContext(entry.contextWindow)}
      </span>
      <span
        className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted"
        title={status.label}
      >
        <span className={cn('h-2 w-2 rounded-full', status.dot)} />
      </span>
    </Wrapper>
  )
}

/** The "let the app pick" choice — same row shape/height as CatalogRow so it
 *  reads as an equally first-class option, not a fallback bolted onto the
 *  bottom. Placed first because it's the recommended default (see the
 *  Model Assignment section's own intro copy). */
function AutomaticRow({
  selected,
  onSelect
}: {
  selected?: boolean
  onSelect?: () => void
}): React.JSX.Element {
  const Wrapper = onSelect ? 'button' : 'div'
  return (
    <Wrapper
      type={onSelect ? 'button' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]',
        onSelect && 'transition hover:bg-elevated',
        selected && 'bg-accent-soft'
      )}
    >
      <div className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-accent-soft">
        <Sparkles className="h-3.5 w-3.5 text-accent" />
      </div>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">Automatic (recommended)</span>
        <span className="block text-[11px] text-faint">
          Picks the best available model from your configured keys — adapts as keys change.
        </span>
      </span>
    </Wrapper>
  )
}

/** BUG-057 Parts 2-3 — makes two previously-invisible states visible right
 *  where a worried user actually looks: "substituting" (running on a
 *  provider other than the one you chose, quietly, since Part 1 added that
 *  fallback) and "failing" (every attempt for this job has failed, for
 *  long enough and often enough that it isn't a blip — see
 *  purpose-health.ts's own severityOf() for the exact thresholds). 'ok'
 *  and 'not-configured' render nothing here — 'not-configured' is already
 *  covered by the existing "No key" status dot on each catalog row. */
function PurposeHealthNotice({ health }: { health: PurposeHealthView | undefined }): React.JSX.Element | null {
  if (!health || health.severity === 'ok' || health.severity === 'not-configured') return null
  const isFailing = health.severity === 'failing'
  return (
    <p
      className={cn(
        'mb-2.5 rounded-lg border px-2.5 py-2 text-[12px]',
        isFailing
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
      )}
    >
      {health.message}
    </p>
  )
}

function JobCard({
  job,
  catalog,
  primaryId,
  health,
  onAssign,
  onReset
}: {
  job: JobConfig
  catalog: AiResolvedCatalogEntry[]
  primaryId: string | null
  health: PurposeHealthView | undefined
  onAssign: (catalogId: string) => Promise<void>
  onReset: () => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [assigning, setAssigning] = useState<string | null>(null)
  const primary = catalog.find((e) => e.id === primaryId) ?? null

  const pick = async (catalogId: string): Promise<void> => {
    if (assigning) return
    setAssigning(catalogId)
    try {
      await onAssign(catalogId)
      setOpen(false)
    } finally {
      setAssigning(null)
    }
  }

  const pickAutomatic = async (): Promise<void> => {
    if (assigning) return
    setAssigning('automatic')
    try {
      await onReset()
      setOpen(false)
    } finally {
      setAssigning(null)
    }
  }

  return (
    <Card className="mb-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{job.title}</h3>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
        >
          Change
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>
      <p className="mb-2.5 text-[13px] text-muted">{job.blurb}</p>
      <PurposeHealthNotice health={health} />

      <div className="rounded-lg border border-line-soft">
        {primary ? <CatalogRow entry={primary} /> : <AutomaticRow selected />}
      </div>

      {open && (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-line-soft p-1">
          <div className="relative">
            <AutomaticRow selected={primaryId === null} onSelect={() => void pickAutomatic()} />
            {assigning === 'automatic' && (
              <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted" />
            )}
          </div>
          <div className="my-1 border-t border-line-soft" />
          {catalog.map((entry) => (
            <div key={entry.id} className="relative">
              <CatalogRow
                entry={entry}
                selected={entry.id === primaryId}
                onSelect={() => void pick(entry.id)}
              />
              {assigning === entry.id && (
                <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted" />
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function RecentFallbackActivity(): React.JSX.Element | null {
  const [events, setEvents] = useState<AiFallbackEventView[] | null>(null)

  useEffect(() => {
    void window.api.aiFallback.recentEvents().then(setEvents)
  }, [])

  if (!events || events.length === 0) return null

  return (
    <Card className="mb-4">
      <h3 className="mb-1 text-sm font-medium">Recent fallback activity</h3>
      <p className="mb-2.5 text-[13px] text-muted">
        When a model fails (rate limit, timeout, delisted) the next one in its chain takes over
        automatically. Local to this device only.
      </p>
      <ul className="space-y-1.5">
        {events.slice(0, 10).map((e, i) => (
          <li key={i} className="text-[12px] text-faint">
            <span className="text-muted">{new Date(e.ts).toLocaleString()}</span> — {e.purpose}:{' '}
            {e.fromDisplayName} failed ({e.reason})
            {e.toDisplayName ? ` → ${e.toDisplayName}` : ' — chain exhausted'}
            {e.detail && <span className="block text-faint/80">↳ {e.detail}</span>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Per-job model assignment (M20) — which catalog model handles each of the
 *  5 jobs, with an automatic fallback chain. Separate page from API keys
 *  (ApiKeysSection.tsx) since picking from an 11-entry catalog × 5 jobs is a
 *  materially bigger UI than a key-entry section. */
export function ModelAssignmentSection(): React.JSX.Element {
  const { settings } = useAppSettings()
  const [catalog, setCatalog] = useState<AiResolvedCatalogEntry[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // BUG-057 Parts 2-3 — polled rather than pushed: this page is exactly
  // where a worried user comes to look, not somewhere a live push needs to
  // interrupt. A stale-by-a-minute severity here costs nothing a manual
  // reopen of Settings doesn't already fix.
  const [health, setHealth] = useState<Partial<Record<AiPurpose, PurposeHealthView>>>({})

  useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      void window.api.purposeHealth.getAll().then((v) => {
        if (!cancelled) setHealth(v)
      })
    }
    poll()
    const id = window.setInterval(poll, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])
  // Seeded from useAppSettings on first paint, then updated directly from
  // assignPrimaryModel()'s own return value — NOT by calling the generic
  // settings.update() with a no-op patch, which would still bump
  // settingsUpdatedAt (saveAppSettings stamps it unconditionally) and
  // trigger a spurious cloud-sync write for a patch that changed nothing.
  const [assignments, setAssignments] = useState(settings.aiModelAssignments)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAssignments(settings.aiModelAssignments)
  }, [settings.aiModelAssignments])

  const load = async (forceRefresh = false): Promise<void> => {
    setRefreshing(true)
    try {
      const resolved = await window.api.aiCatalog.resolve(forceRefresh)
      setCatalog(resolved)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [])

  const assign = async (purpose: AiPurpose, catalogId: string): Promise<void> => {
    const next = await window.api.aiCatalog.assignPrimaryModel(purpose, catalogId)
    setAssignments(next.aiModelAssignments)
  }

  const reset = async (purpose: AiPurpose): Promise<void> => {
    const next = await window.api.aiCatalog.resetToAutomatic(purpose)
    setAssignments(next.aiModelAssignments)
  }

  if (!catalog) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading catalog…
      </div>
    )
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          Each job defaults to <span className="font-medium text-ink">Automatic</span> — the app
          picks the best available model from your configured keys, and adapts if a key is added or
          removed. Pick a specific model instead if you want to lock one in; picking one promotes it
          to the front of that job&rsquo;s fallback chain. Free tiers rate-limit and rosters change;
          a model with no key configured for its provider is simply skipped at runtime either way.
        </p>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:opacity-60"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh availability
        </button>
      </div>

      <RecentFallbackActivity />

      {JOBS.map((job) => (
        <JobCard
          key={job.purpose}
          job={job}
          catalog={catalog}
          primaryId={assignments[job.purpose].chain[0] ?? null}
          health={health[job.purpose]}
          onAssign={(catalogId) => assign(job.purpose, catalogId)}
          onReset={() => reset(job.purpose)}
        />
      ))}
    </>
  )
}
