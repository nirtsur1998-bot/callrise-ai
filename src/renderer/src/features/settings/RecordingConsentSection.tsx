import { useState } from 'react'
import { ShieldCheck, ShieldOff, RotateCcw, AlertTriangle } from 'lucide-react'
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
  const always = settings.alwaysRecordOtherParty

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
              ? always
                ? 'Buyer-side recording is available, and “Always record the other party” below is on — so consent is recorded as pre-agreed at the start of every call instead of being asked for on each one. This switch never records anything by itself; turning it off removes the capability entirely.'
                : 'Buyer-side recording is available. It still only ever happens after you explicitly confirm consent on each call — this switch never records anything by itself, it only allows the per-call consent step to appear.'
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

      {/* Standing consent. Deliberately placed under the master switch and
          worded to be honest about what it does: it records a consent, it does
          not skip one. */}
      <Card className={cn('mb-5', !allowed && 'opacity-50')}>
        <SettingRow
          title="Always record the other party"
          description={
            always
              ? 'Every call starts already consented, so the buyer side begins transcribing on its own — no per-call consent step. Each call is still saved with a consent record marked “pre-agreed”, so what you recorded and why stays on the record.'
              : 'Skip the per-call consent step: every call starts already consented and the buyer side begins transcribing automatically. Each call is still saved with a consent record marked “pre-agreed”.'
          }
          control={
            <ToggleSwitch
              checked={always}
              disabled={loading || !allowed}
              onChange={(v) => void update({ alwaysRecordOtherParty: v })}
              label="Always record the other party"
            />
          }
        />
        <p className="mt-3 flex items-start gap-2 border-t border-line-soft pt-3 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Only turn this on if you already have a standing basis to record — a recorded-line
            notice, a signed agreement, or a one-party jurisdiction. It stops the app from asking on
            each call; it does not obtain consent for you.
          </span>
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
