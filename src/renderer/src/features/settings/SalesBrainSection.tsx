import { useEffect, useRef, useState } from 'react'
import { Brain, RotateCcw, Download } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { Button } from '@renderer/components/Button'
import { useAppSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'
import { OnboardingInterviewModal } from './OnboardingInterviewModal'
import type { OnboardingStatusResult, SalesBrainBackfillProgress } from '../../../../preload/index.d'

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
  const [backfill, setBackfill] = useState<SalesBrainBackfillProgress | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
    if (!enabled) return
    void window.api.salesBrain.backfill.status().then(setBackfill)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once when this section becomes relevant
  }, [enabled])

  useEffect(() => {
    if (backfill?.running && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void window.api.salesBrain.backfill.status().then((p) => {
          setBackfill(p)
          if (!p.running && pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
        })
      }, 1000)
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [backfill?.running])

  const startBackfill = async (): Promise<void> => {
    const result = await window.api.salesBrain.backfill.start({
      includeContacts: true,
      includeDeals: true,
      includeCalls
    })
    if (result.ok) {
      const p = await window.api.salesBrain.backfill.status()
      setBackfill(p)
    }
  }

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
                  disabled={backfill?.running}
                />
                Also scan past calls
              </label>
              {backfill?.running && (
                <p className="mt-1 text-[11px] text-accent">
                  {backfill.stage === 'contacts'
                    ? 'Scanning contacts'
                    : backfill.stage === 'deals'
                      ? 'Scanning deals'
                      : 'Scanning calls'}
                  … {backfill.processed} / {backfill.total}
                </p>
              )}
              {backfill?.stage === 'done' && !backfill.running && (
                <p className="mt-1 text-[11px] text-success">Import complete.</p>
              )}
              {backfill?.stage === 'error' && (
                <p className="mt-1 text-[11px] text-danger">Something went wrong: {backfill.lastError}</p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              onClick={() => void startBackfill()}
              disabled={backfill?.running}
            >
              {backfill?.running ? 'Importing…' : 'Import now'}
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
