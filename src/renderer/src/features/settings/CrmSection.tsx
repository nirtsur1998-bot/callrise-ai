import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { CountrySelect } from '@renderer/components/CountrySelect'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { cn } from '@renderer/lib/cn'
import { fieldClass } from '@renderer/components/field'
import { clearAllDismissedMatches } from '@renderer/features/contacts/calendarMatch'
import { useAppSettings, type CrmSettings } from './useAppSettings'
import { SettingRow } from './SettingRow'

type MatchSensitivity = CrmSettings['matchSensitivity']
type ContactIntelligenceMode = 'off' | 'suggest' | 'full-auto'

const SENSITIVITIES: { id: MatchSensitivity; label: string }[] = [
  { id: 'tight', label: 'Tight (5 min)' },
  { id: 'normal', label: 'Normal (15 min)' },
  { id: 'loose', label: 'Loose (30 min)' }
]

const CONTACT_INTELLIGENCE_OPTIONS: { id: ContactIntelligenceMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'suggest', label: 'Suggest' },
  { id: 'full-auto', label: 'Full-auto' }
]

const CONTACT_INTELLIGENCE_DESCRIPTION: Record<ContactIntelligenceMode, string> = {
  off: 'Off — no automatic name detection beyond the calendar-match banner above.',
  suggest:
    "Suggest — on a one-on-one call with no linked contact, a 'Detect who this was' button sends the transcript to Claude to look for a self-introduced name (only if they explicitly said it). Finding a contact still always needs your click.",
  'full-auto':
    'Full-auto — the same AI detection runs on its own (once per call) instead of waiting for a click. Creating a contact is still never automatic — you always confirm.'
}

export function CrmSection(): React.JSX.Element {
  const { settings, loading, update } = useAppSettings()
  const crm = settings.crm
  const contactIntelligenceMode = settings.contactIntelligence.mode
  const [cleared, setCleared] = useState(false)

  const setCrm = (patch: Partial<CrmSettings>): void => {
    void update({ crm: patch })
  }

  // Text/number inputs edit a LOCAL draft and commit on blur. Saving per
  // keystroke through async IPC dropped characters (React reverts the DOM to
  // the stale value until the round-trip resolves), snapped a cleared prefix
  // back to "CUST-" mid-typing, and burned a disk write per keystroke.
  const [prefixDraft, setPrefixDraft] = useState(crm.cidPrefix)
  const [staleDraft, setStaleDraft] = useState(String(crm.staleAfterDays))
  /* eslint-disable react-hooks/set-state-in-effect -- sync drafts when the async-loaded settings arrive */
  useEffect(() => {
    setPrefixDraft(crm.cidPrefix)
  }, [crm.cidPrefix])
  useEffect(() => {
    setStaleDraft(String(crm.staleAfterDays))
  }, [crm.staleAfterDays])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Transient "Saved" labels next to blur-committed fields, auto-clearing
  // after ~2s — mirrors the "Cleared." message below.
  const [savedField, setSavedField] = useState<'prefix' | 'staleDays' | null>(null)
  const savedTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashSaved = (field: 'prefix' | 'staleDays'): void => {
    setSavedField(field)
    clearTimeout(savedTimeout.current)
    savedTimeout.current = setTimeout(() => setSavedField(null), 2000)
  }
  useEffect(() => () => clearTimeout(savedTimeout.current), [])

  const commitPrefix = (): void => {
    const next = prefixDraft.trim() || 'CUST-'
    setPrefixDraft(next)
    if (next !== crm.cidPrefix) {
      setCrm({ cidPrefix: next })
      flashSaved('prefix')
    }
  }
  const commitStaleDays = (): void => {
    const next = Math.min(Math.max(Math.round(Number(staleDraft) || 14), 1), 365)
    setStaleDraft(String(next))
    if (next !== crm.staleAfterDays) {
      setCrm({ staleAfterDays: next })
      flashSaved('staleDays')
    }
  }

  return (
    <>
      <Card className="mb-5">
        <SettingRow
          title="Calendar-match suggestions"
          description="When a saved call happens around the same time as a calendar invite, offer to link it to that attendee's contact. Always confirmed — never links or creates anything on its own unless auto-link (below) is also on."
          control={
            <ToggleSwitch
              checked={crm.calendarMatchEnabled}
              disabled={loading}
              onChange={(v) => setCrm({ calendarMatchEnabled: v })}
              label="Calendar-match suggestions"
            />
          }
        />

        <div
          className={cn(
            'mt-4 border-t border-line-soft pt-4',
            !crm.calendarMatchEnabled && 'opacity-50'
          )}
        >
          <p className="mb-2 text-[13px] font-medium">Match sensitivity</p>
          <SegmentedControl
            options={SENSITIVITIES}
            value={crm.matchSensitivity}
            onChange={(id) => setCrm({ matchSensitivity: id })}
            disabled={!crm.calendarMatchEnabled || loading}
          />
          <p className="mt-2 text-[11px] text-faint">
            How close a calendar event must be to the call&rsquo;s actual time to count as a match.
          </p>
        </div>

        <div
          className={cn(
            'mt-4 border-t border-line-soft pt-4',
            !crm.calendarMatchEnabled && 'opacity-50'
          )}
        >
          <SettingRow
            title="Auto-link unambiguous matches"
            description="When exactly one calendar match points to a contact you already have, link it automatically instead of asking — you'll still see a notice, and can undo it. Never auto-creates a new contact."
            control={
              <ToggleSwitch
                checked={crm.autoLinkUnambiguous}
                disabled={!crm.calendarMatchEnabled || loading}
                onChange={(v) => setCrm({ autoLinkUnambiguous: v })}
                label="Auto-link unambiguous matches"
              />
            }
          />
        </div>

        <div className="mt-4 border-t border-line-soft pt-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Dismissed suggestions</p>
              <p className="mt-1 text-[12px] text-muted">
                Bring back any calendar-match suggestions you dismissed with &ldquo;Not now&rdquo;.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                clearAllDismissedMatches()
                setCleared(true)
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Show again
            </button>
          </div>
          {cleared && <p className="mt-2 text-[12px] text-positive">Cleared.</p>}
        </div>
      </Card>

      <Card className="mb-5">
        <p className="mb-1 text-sm font-medium">Default country for new contacts</p>
        <p className="mb-3 text-[12px] text-muted">
          Pre-fills the country field — still editable per contact.
        </p>
        <CountrySelect
          value={crm.defaultCountry || undefined}
          onChange={(code) => setCrm({ defaultCountry: code ?? '' })}
          placeholder="No default"
        />
      </Card>

      <Card className="mb-5">
        <SettingRow
          title="Auto-numbered Customer No."
          description="Automatically fill in a sequential customer number for new contacts that don't have one — still editable per contact."
          control={
            <ToggleSwitch
              checked={crm.autoNumberCid}
              disabled={loading}
              onChange={(v) => setCrm({ autoNumberCid: v })}
              label="Auto-numbered Customer No."
            />
          }
        />
        <div
          className={cn('mt-4 border-t border-line-soft pt-4', !crm.autoNumberCid && 'opacity-50')}
        >
          <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-muted">
            Prefix
            {savedField === 'prefix' && <span className="text-[12px] text-positive">Saved</span>}
          </label>
          <input
            value={prefixDraft}
            disabled={!crm.autoNumberCid || loading}
            onChange={(e) => setPrefixDraft(e.target.value)}
            onBlur={commitPrefix}
            placeholder="CUST-"
            className={cn(fieldClass, 'max-w-[200px]')}
          />
          <p className="mt-2 text-[11px] text-faint">
            Next number: {crm.cidPrefix}
            {crm.cidNextNumber}
          </p>
        </div>
      </Card>

      <Card className="mb-5">
        <SettingRow
          title="Needs-follow-up flagging"
          description="Flag an open deal once its contact hasn't had a call in a while, and offer a one-tap button to create a follow-up task. Turn this off to hide the flag entirely — it won't just be muted."
          control={
            <ToggleSwitch
              checked={crm.staleFollowUpEnabled}
              disabled={loading}
              onChange={(v) => setCrm({ staleFollowUpEnabled: v })}
              label="Needs-follow-up flagging"
            />
          }
        />
        <div
          className={cn(
            'mt-4 border-t border-line-soft pt-4',
            !crm.staleFollowUpEnabled && 'opacity-50'
          )}
        >
          <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-muted">
            Flag after this many days without a call
            {savedField === 'staleDays' && <span className="text-[12px] text-positive">Saved</span>}
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={staleDraft}
            disabled={!crm.staleFollowUpEnabled || loading}
            onChange={(e) => setStaleDraft(e.target.value)}
            onBlur={commitStaleDays}
            className={cn(fieldClass, 'w-24')}
          />
          <p className="mt-2 text-[11px] text-faint">Only applies to open (not Won/Lost) deals.</p>
        </div>
      </Card>

      <Card className="mb-5">
        <SettingRow
          title="Auto-generate notes"
          description="When a call gets linked to a contact (and has a transcript or summary), send it to Claude for a short CRM note appended to that contact — a couple of sentences on what was discussed and where things stand. You'll always see it's AI-drafted, and can delete it any time."
          control={
            <ToggleSwitch
              checked={crm.autoGenerateNotes}
              disabled={loading}
              onChange={(v) => setCrm({ autoGenerateNotes: v })}
              label="Auto-generate notes"
            />
          }
        />
      </Card>

      <Card className="mb-5">
        <SettingRow
          title="CRM Note Generator"
          description="Adds a 'Generate CRM note' card to each contact's page — draft a note (Short/Medium/Detailed) from their most recent call on demand, plus proposed KYC updates you can accept or reject one at a time. On-demand only, never automatic."
          control={
            <ToggleSwitch
              checked={crm.noteGeneratorEnabled}
              disabled={loading}
              onChange={(v) => setCrm({ noteGeneratorEnabled: v })}
              label="CRM Note Generator"
            />
          }
        />
      </Card>

      <Card className="mb-5">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[13px] font-medium text-ink">Contact Intelligence</p>
          <SegmentedControl
            options={CONTACT_INTELLIGENCE_OPTIONS}
            value={contactIntelligenceMode}
            disabled={loading}
            onChange={(mode) =>
              // This toggle is the only reachable UI for the older, more
              // specific speakerId.allowSelfIntroExtraction opt-in (buyer
              // speech reaching a third-party LLM for self-intro detection)
              // — keep the two in lockstep so this one control genuinely
              // represents the rep's full consent state, on and off.
              void update({
                contactIntelligence: { mode },
                speakerId: { allowSelfIntroExtraction: mode !== 'off' }
              })
            }
          />
        </div>
        <p className="text-[12px] text-faint">{CONTACT_INTELLIGENCE_DESCRIPTION[contactIntelligenceMode]}</p>
      </Card>
    </>
  )
}
