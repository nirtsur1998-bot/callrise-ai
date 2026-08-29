import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import type { AuthUser } from '@renderer/features/auth/types'
import {
  SETTINGS_GROUPS,
  ALL_SETTINGS_PAGES,
  ALERTS_BACKEND_LIVE,
  buildSettingsGroups,
  resolvePageId,
  type SettingsPageId
} from './settings-nav'
import { useSettingsPreview } from './useSettingsPreview'
import { AccountSection } from './AccountSection'
import { ApiKeysSection } from './ApiKeysSection'
import { ModelAssignmentSection } from './ModelAssignmentSection'
import { AINoteTakerSection } from './AINoteTakerSection'
import { DetectionSection } from './DetectionSection'
import { RecordingConsentSection } from './RecordingConsentSection'
import { AudioSection } from './AudioSection'
import { CoachingSection } from './CoachingSection'
import { LiveDealIntelligenceSection } from './LiveDealIntelligenceSection'
import { SummaryLanguageSection } from './SummaryLanguageSection'
import { PersonalizationSection } from './PersonalizationSection'
import { ObjectionLibrarySection } from './ObjectionLibrarySection'
import { Coach2Section } from './Coach2Section'
import { SalesBrainSection } from './SalesBrainSection'
import { MemoryCenterSection } from './MemoryCenterSection'
import { CalendarSection } from './CalendarSection'
import { CrmSection } from './CrmSection'
import { AlertsSection } from '@renderer/features/alerts/AlertsSection'
import { AppSection } from './AppSection'
import { AppearanceSection } from './AppearanceSection'
import { PrivacyDataPage } from './PrivacyDataPage'
import { TelemetrySection } from './TelemetrySection'
import { JobInspectorSection } from './JobInspectorSection'

const PAGE_CONTENT: Record<SettingsPageId, React.ComponentType> = {
  account: AccountSection,
  'ai-setup': ApiKeysSection,
  'ai-models': ModelAssignmentSection,
  'ai-note-taker': AINoteTakerSection,
  'call-detection': DetectionSection,
  'recording-consent': RecordingConsentSection,
  audio: AudioSection,
  coaching: CoachingSection,
  'live-deal-intelligence': LiveDealIntelligenceSection,
  'summary-language': SummaryLanguageSection,
  personalization: PersonalizationSection,
  'objection-library': ObjectionLibrarySection,
  coach2: Coach2Section,
  'sales-brain': SalesBrainSection,
  'sales-brain-memories': MemoryCenterSection,
  calendar: CalendarSection,
  crm: CrmSection,
  alerts: AlertsSection,
  app: AppSection,
  appearance: AppearanceSection,
  'privacy-data': PrivacyDataPage,
  telemetry: TelemetrySection,
  'jobs-inspector': JobInspectorSection
}

/* M31 Stage 5 — the two pages the reworked IA merges.
 *
 * Composition, not rewriting: each merged page renders the SAME section
 * components the separate pages rendered, in order, unmodified. That is the
 * whole implementation on purpose — it means "merged" cannot quietly become
 * "one of them lost a control", and turning the preview off restores two
 * pages that were never edited. Neither section grew a prop or a mode.
 *
 * The sections already render their own headings, so nothing is added here to
 * label them; a wrapper that invented its own headers would be a second place
 * for the copy to drift.
 */
function NotesAndSummariesSection(): React.JSX.Element {
  return (
    <>
      <AINoteTakerSection />
      <SummaryLanguageSection />
    </>
  )
}

function CoachingCombinedSection(): React.JSX.Element {
  return (
    <>
      <CoachingSection />
      <Coach2Section />
    </>
  )
}

/** Only the pages whose CONTENT differs under the preview. Everything else
 *  falls through to PAGE_CONTENT, so the preview cannot accidentally change a
 *  page it was only supposed to re-file. */
const PAGE_CONTENT_PREVIEW: Partial<Record<SettingsPageId, React.ComponentType>> = {
  'ai-note-taker': NotesAndSummariesSection,
  coaching: CoachingCombinedSection
}

interface SettingsShellProps {
  user: AuthUser
  /** Return to the main app (whichever screen was active before Settings). */
  onBack: () => void
}

/** A dedicated full-screen settings surface — replaces the normal 3-column
 *  app shell entirely (no main sidebar, no copilot) while active, matching
 *  the Krisp-style "settings window" pattern: its own left nav grouped by
 *  category, one page per setting, and a Back arrow to return to the app. */
export function SettingsShell({ user, onBack }: SettingsShellProps): React.JSX.Element {
  const { enabled: previewIA } = useSettingsPreview()
  const [rawPage, setPage] = useState<SettingsPageId>('account')

  // Recomputed rather than module-constant, because the preview can be toggled
  // while Settings is open — the toggle lives on the Appearance page, which is
  // inside this very shell.
  const groups = previewIA ? buildSettingsGroups(ALERTS_BACKEND_LIVE, true) : SETTINGS_GROUPS
  const pages = previewIA ? groups.flatMap((g) => g.items) : ALL_SETTINGS_PAGES

  // Toggling the preview off while sitting on a page the other IA does not
  // have (or on an absorbed page) must not blank the pane. Resolving on read
  // rather than writing back into state keeps the flip reversible: turn the
  // preview on again and you are back where you were.
  const page = resolvePageId(rawPage, groups)
  const active = pages.find((p) => p.id === page) ?? pages[0]
  const PageContent =
    (previewIA ? PAGE_CONTENT_PREVIEW[page] : undefined) ?? PAGE_CONTENT[page] ?? PAGE_CONTENT.account
  const displayName = user.name?.trim() || user.email.split('@')[0]

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-ink">
      {/* Left: settings navigation */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-line-soft bg-surface">
        <div className={cn('drag px-4 pb-3', isMac ? 'pt-9' : 'pt-4')}>
          <button
            type="button"
            onClick={onBack}
            className="no-drag mb-4 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <p className="truncate px-2 text-[13px] font-medium text-faint">{displayName}</p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {/* Tighter group rhythm under the preview only. 16px between groups
              was sized for eleven of them; with seven, that much air is what
              pushes the last group off the bottom of the screen. Note this is
              a TERNARY, not `cn('space-y-4', preview && 'space-y-2')` — `cn`
              here is a plain join, not tailwind-merge, so both classes would
              be emitted and the winner decided by stylesheet order. */}
          <ul className={previewIA ? 'space-y-1.5' : 'space-y-4'}>
            {groups.map((group, i) => (
              <li key={group.label ?? `group-${i}`}>
                {group.label && group.items.length > 1 && (
                  <p
                    className={cn(
                      'px-2 text-[11px] font-semibold tracking-wide text-faint uppercase',
                      // Under the preview the label carries its own top space
                      // instead of the list's uniform gap, so a heading sits
                      // clearly with the items below it rather than floating
                      // equidistant between two groups.
                      previewIA ? 'mt-3 mb-1 first:mt-0' : 'mb-1.5'
                    )}
                  >
                    {group.label}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon
                    const isActive = item.id === page
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => setPage(item.id)}
                          className={cn(
                            'no-drag flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors',
                            isActive
                              ? 'bg-accent-soft text-ink'
                              : 'text-muted hover:bg-elevated hover:text-ink'
                          )}
                        >
                          <Icon
                            className={cn(
                              'h-4 w-4 shrink-0',
                              isActive ? 'text-accent' : 'text-faint'
                            )}
                            strokeWidth={2}
                          />
                          <span className="truncate font-medium">{item.label}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Right: the selected settings page */}
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <header className="drag flex h-14 shrink-0 items-center border-b border-line-soft px-8">
          <h1 className="text-sm font-medium">{active.label}</h1>
        </header>
        <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-8 py-7">
          {active.description && (
            <p className="mb-5 text-[13px] text-muted">{active.description}</p>
          )}
          <PageContent />
        </div>
      </main>
    </div>
  )
}
