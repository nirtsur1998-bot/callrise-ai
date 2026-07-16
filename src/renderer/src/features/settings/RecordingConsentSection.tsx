import { useState } from 'react'
import { ShieldCheck, ShieldOff, RotateCcw } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { cn } from '@renderer/lib/cn'
import { fieldClass } from '@renderer/components/field'
import type { ConsentJurisdiction } from '@renderer/features/calls/types'
import {
  DEFAULT_SCRIPT,
  loadDefaultJurisdiction,
  saveDefaultJurisdiction,
  loadScript,
  saveScript
} from '@renderer/features/consent/prefs'
import { useAppSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'

const JURISDICTIONS: { id: ConsentJurisdiction; label: string }[] = [
  { id: 'two-party', label: 'Two-party (safer default)' },
  { id: 'one-party', label: 'One-party' }
]

export function RecordingConsentSection(): React.JSX.Element {
  const { settings, loading, update } = useAppSettings()
  const allowed = settings.allowOtherPartyRecording

  const [jurisdiction, setJurisdictionState] = useState<ConsentJurisdiction>(() =>
    loadDefaultJurisdiction()
  )
  const [script, setScriptState] = useState<string>(() => loadScript())

  const setJurisdiction = (j: ConsentJurisdiction): void => {
    saveDefaultJurisdiction(j)
    setJurisdictionState(j)
  }

  const setScript = (s: string): void => {
    saveScript(s)
    setScriptState(s)
  }

  const resetScript = (): void => {
    saveScript(DEFAULT_SCRIPT)
    setScriptState(DEFAULT_SCRIPT)
  }

  return (
    <>
      {/* The master switch — deliberately the most prominent card in Settings. */}
      <Card
        className={cn(
          'mb-5 border-2',
          allowed ? 'border-line-soft' : 'border-accent/30 bg-accent-soft'
        )}
      >
        <SettingRow
          title="Allow recording the other party"
          description={
            allowed
              ? 'Buyer-side recording is available. It still only ever happens after you explicitly confirm consent on each call — this switch never records anything by itself, it only allows the per-call consent step to appear.'
              : "Buyer-side recording is completely unavailable. The consent step won't appear on calls, and no buyer audio can be captured — this only removes capability, it never grants it."
          }
          control={
            <div className="flex items-center gap-2">
              {allowed ? (
                <ShieldCheck className="h-4 w-4 text-positive" />
              ) : (
                <ShieldOff className="h-4 w-4 text-accent" />
              )}
              <ToggleSwitch
                checked={allowed}
                disabled={loading}
                onChange={(v) => void update({ allowOtherPartyRecording: v })}
                label="Allow recording the other party"
              />
            </div>
          }
        />
        <p className="mt-3 border-t border-line-soft pt-3 text-[11px] text-faint">
          Consent laws for recording calls vary by location — check what applies where you and the
          other party are before recording them.
        </p>
      </Card>

      <Card className={cn('mb-5', !allowed && 'opacity-50')}>
        <p className="mb-2 text-sm font-medium">Default consent jurisdiction</p>
        <p className="mb-3 text-[12px] text-muted">
          Pre-fills the per-call consent step — you can still change it on any individual call.
        </p>
        <SegmentedControl
          options={JURISDICTIONS}
          value={jurisdiction}
          onChange={setJurisdiction}
          disabled={!allowed}
        />
      </Card>

      <Card className={cn('mb-5', !allowed && 'opacity-50')}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Consent disclosure script</p>
          <button
            type="button"
            disabled={!allowed}
            onClick={resetScript}
            className="flex items-center gap-1 text-[12px] text-muted transition hover:text-ink disabled:cursor-default disabled:opacity-60"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        </div>
        <p className="mb-2 text-[12px] text-muted">
          What you say to ask for consent — pre-filled into the per-call consent step, editable
          there too.
        </p>
        <textarea
          value={script}
          disabled={!allowed}
          onChange={(e) => setScript(e.target.value)}
          rows={3}
          className={cn(fieldClass, 'resize-y')}
        />
      </Card>
    </>
  )
}
