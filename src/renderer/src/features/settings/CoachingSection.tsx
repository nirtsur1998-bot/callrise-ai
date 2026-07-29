import { useEffect, useState } from 'react'
import { X, Sparkles } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { fieldClass } from '@renderer/components/field'
import { useCueSettings } from '@renderer/features/live/useCueSettings'
import { SENSITIVITIES, type Sensitivity } from '@renderer/features/live/useLiveCues'
import { sanitizeGeneratedTrigger } from '@renderer/features/live/battlecards/from-prompt'
import type { Trigger } from '@renderer/features/live/battlecards/match'
import { SettingRow } from './SettingRow'

const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

const SENSITIVITY_OPTIONS = SENSITIVITIES.map((s) => ({ id: s, label: SENSITIVITY_LABEL[s] }))

export function CoachingSection(): React.JSX.Element {
  const { enabled, setEnabled, sensitivity, setSensitivity } = useCueSettings()

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Live coaching cues"
          description="Glanceable cues during a call — objections, discovery gaps, buying signals, and a rep-only pace nudge. Turns on automatically once a call starts listening, if enabled here."
          control={
            <ToggleSwitch checked={enabled} onChange={setEnabled} label="Show live coaching cues" />
          }
        />

        <div className={cn('mt-4 border-t border-line-soft pt-4', !enabled && 'opacity-50')}>
          <p className="mb-2 text-[13px] font-medium">Default sensitivity</p>
          <SegmentedControl
            options={SENSITIVITY_OPTIONS}
            value={sensitivity}
            onChange={setSensitivity}
            disabled={!enabled}
          />
          <p className="mt-2 text-[11px] text-faint">
            Low shows cues least often (calmest); High shows them most often.
          </p>
        </div>
      </Card>

      <CustomTrackersCard />
    </>
  )
}

function CustomTrackersCard(): React.JSX.Element {
  const [trackers, setTrackers] = useState<Trigger[]>([])
  const [loaded, setLoaded] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.trackers
      .list()
      .then((list) => {
        if (!cancelled) setTrackers(list)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const create = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.trackers.generate(text)
      if (!res.ok) {
        setError(
          res.error === 'no-key'
            ? 'Add your Claude or ChatGPT API key in Settings → API keys first.'
            : (res.message ?? 'Could not create that tracker. Please try again.')
        )
        return
      }
      // Held to the exact same precision bar as the curated starter library —
      // a generated card that fires on every other sentence is worse than one
      // that never fires at all, so a rejection here is expected, not a bug.
      const result = sanitizeGeneratedTrigger(res.raw, new Set(trackers.map((t) => t.id)))
      if (!result.ok) {
        setError(`Couldn't make that specific enough: ${result.reason}.`)
        return
      }
      const next = [...trackers, result.trigger]
      setTrackers(next)
      setPrompt('')
      await window.api.trackers.save(next)
    } catch {
      setError('Could not create that tracker. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    const next = trackers.filter((t) => t.id !== id)
    setTrackers(next)
    await window.api.trackers.save(next).catch(() => {})
  }

  return (
    <Card className="mb-5">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">Custom trackers</h3>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        Describe what to watch for in plain English and it works on your next call — no admin
        console, no waiting for someone else to add it.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
          placeholder='e.g. "tell me when someone mentions procurement"'
          className={fieldClass}
          disabled={busy}
        />
        <Button onClick={create} disabled={busy || !prompt.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}

      {loaded && trackers.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-line-soft pt-4">
          {trackers.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-canvas px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium">{t.card.label}</p>
                <p className="truncate text-[11px] text-faint">{t.card.say}</p>
              </div>
              <IconButton
                icon={X}
                label={`Remove ${t.card.label}`}
                onClick={() => void remove(t.id)}
                className="shrink-0"
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
