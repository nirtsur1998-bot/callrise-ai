import { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, RotateCcw, Download } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { Button } from '@renderer/components/Button'
import { useAppSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'
import { OnboardingInterviewModal } from './OnboardingInterviewModal'
import type { Job, OnboardingStatusResult } from '../../../../preload/index.d'

const BACKFILL_JOB_TYPE = 'salesBrain:backfill'

/**
 * M25 — the master switch for the whole Sales Brain milestone. Off by
 * default: nothing in the memory module runs at all until this is on (no
 * database file, no extraction, no AI calls, nothing injected anywhere
 * else in the app — see docs/M25-sales-brain.md). Turning it on for the
 * first time launches the onboarding interview automatically; it's also
 * re-runnable here any time.
 */
export function SalesBrainSection(): React.JSX.Element {
  const { settings, update } = useAppSettings()
  const enabled = settings.salesBrain.enabled
  const [showInterview, setShowInterview] = useState(false)
  const [status, setStatus] = useState<OnboardingStatusResult | null>(null)
  const [includeCalls, setIncludeCalls] = useState(false)
  const [backfillJob, setBackfillJob] = useState<Job | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const refreshStatus = (): void => {
    if (!enabled) return
    void window.api.salesBrain.onboarding.status().then(setStatus)
  }

  useEffect(() => {
    refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch whenever the toggle changes
  }, [enabled])

  const onToggle = async (next: boolean): Promise<void> => {
    await update({ salesBrain: { enabled: next } })
    if (next) {
      // First time on (or re-enabled with setup never finished) — offer
      // the interview right away rather than waiting for the rep to find
      // it. status is fetched after the settings write resolves, so a
      // brand-new memory.db has had a moment to be created/migrated.
      const s = await window.api.salesBrain.onboarding.status()
      setStatus(s)
      if (s.status === 'not-started' || s.status === 'in-progress') setShowInterview(true)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // M26 Phase 3 — adopt an already-running/queued import on mount (the rep
  // started it, left Settings, and came back), and keep tracking whichever
  // import job is current from then on. This IS the fix for "navigating
  // away loses the visible progress" — the import itself never needed
  // rescuing, only this screen's view of it (same pattern as the objection
  // scan card's job tracking).
  useEffect(() => {
    if (!enabled) return
    void window.api.jobs.list().then((jobs) => {
      if (!mountedRef.current) return
      const active = jobs.find(
        (j) => j.type === BACKFILL_JOB_TYPE && (j.state === 'running' || j.state === 'queued')
      )
      if (active) setBackfillJob(active)
    })
    return window.api.jobs.onChanged((jobs) => {
      setBackfillJob((current) => {
        if (!current) return current
        return jobs.find((j) => j.id === current.id) ?? current
      })
    })
  }, [enabled])

  const startBackfill = useCallback(async (): Promise<void> => {
    setStartError(null)
    // The try/catch is the point, not a formality. These calls read a RESULT
    // OBJECT ({ok, message}), so the only failure this screen ever rendered
    // was `ok: false`. A REJECTED ipcMain.handle — main throwing, or the
    // handler not being registered at all — escaped this callback entirely
    // and showed the user nothing whatsoever: the button just did nothing.
    // That's precisely what 1.2.1 shipped (an uncaught throw inside the new
    // ensureMemoryDb retry, since fixed at the source too). Belt-and-braces
    // deliberately: main is now guaranteed not to throw here, and this still
    // catches it if anything ever does again, because "silently does
    // nothing" is the single worst failure mode this button can have.
    try {
      const result = await window.api.salesBrain.backfill.start({
        includeContacts: true,
        includeDeals: true,
        includeCalls
      })
      if (!mountedRef.current) return
      if (result.ok && result.jobId) {
        const fresh = await window.api.jobs.get(result.jobId)
        if (mountedRef.current && fresh) setBackfillJob(fresh)
      } else {
        // Was previously swallowed entirely — the button would just do
        // nothing with no indication why (e.g. "Sales Brain is not ready
        // yet" right after enabling the toggle mid-session, before the fix
        // to initialize memory.db live). Surface it instead of silence.
        setStartError(result.message ?? 'Import could not start.')
      }
    } catch (err) {
      if (!mountedRef.current) return
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }, [includeCalls])

  const importing = backfillJob?.state === 'running' || backfillJob?.state === 'queued'

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Sales Brain (Beta)"
          description="Learns who you are, how you sell, your business, and each client — every AI feature in the app (live cues, coaching, chat, briefs) gets smarter from it over time. Runs entirely on your own device: facts are extracted through your own connected AI provider, but everything is stored and searched locally, never uploaded anywhere by default."
          control={
            <ToggleSwitch
              checked={enabled}
              onChange={(next) => void onToggle(next)}
              label="Sales Brain (Beta)"
            />
          }
        />
      </Card>

      {enabled && (
        <Card className="mb-5">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated text-accent">
              <Brain className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Onboarding interview</h3>
              <p className="text-[12px] text-faint">
                {status?.status === 'finished'
                  ? 'Completed — Sales Brain knows the basics about your business.'
                  : status?.status === 'skipped'
                    ? 'Skipped — you can run it any time.'
                    : status
                      ? `${status.completedCount} of ${status.totalCount} answered.`
                      : 'A short conversational setup to seed what Sales Brain knows on day one.'}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={RotateCcw}
              onClick={() => {
                const alreadyDone = status?.status === 'finished' || status?.status === 'skipped'
                void (alreadyDone ? window.api.salesBrain.onboarding.restart() : Promise.resolve()).then(() =>
                  setShowInterview(true)
                )
              }}
            >
              {status?.status === 'finished' || status?.status === 'skipped' ? 'Run again' : 'Continue'}
            </Button>
          </div>
        </Card>
      )}

      {enabled && (
        <Card className="mb-5">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated text-accent">
              <Download className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Import your past history</h3>
              <p className="text-[12px] text-faint">
                Seed Sales Brain from contacts and deals you've already tracked — instant, no AI cost. Optionally
                also scan past calls (uses your own AI provider, slower, and not free on your account).
              </p>
              <label className="mt-2 flex items-center gap-2 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={includeCalls}
                  onChange={(e) => setIncludeCalls(e.target.checked)}
                  disabled={importing}
                />
                Also scan past calls
              </label>
              {importing && backfillJob?.progress.mode === 'stages' && (
                <p className="mt-1 text-[11px] text-accent">
                  {backfillJob.progress.stageLabel} — safe to leave this screen, tracked in Activity too.
                </p>
              )}
              {backfillJob?.state === 'succeeded' && (
                <p className="mt-1 text-[11px] text-success">{backfillJob.resultRef ?? 'Import complete.'}</p>
              )}
              {backfillJob?.state === 'failed' && (
                <p className="mt-1 text-[11px] text-danger">
                  Something went wrong: {backfillJob.error?.message ?? 'unknown error'}
                </p>
              )}
              {startError && (
                <p className="mt-1 text-[11px] text-danger">Couldn&apos;t start: {startError}</p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              onClick={() => void startBackfill()}
              disabled={importing}
            >
              {importing ? 'Importing…' : 'Import now'}
            </Button>
          </div>
        </Card>
      )}

      {showInterview && (
        <OnboardingInterviewModal onClose={() => setShowInterview(false)} onDone={refreshStatus} />
      )}
    </>
  )
}
