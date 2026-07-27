import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import type { AuthUser } from '@renderer/features/auth/types'
import { SETTINGS_GROUPS, ALL_SETTINGS_PAGES, type SettingsPageId } from './settings-nav'
import { AccountSection } from './AccountSection'
import { ApiKeysSection } from './ApiKeysSection'
import { AINoteTakerSection } from './AINoteTakerSection'
import { DetectionSection } from './DetectionSection'
import { RecordingConsentSection } from './RecordingConsentSection'
import { AudioSection } from './AudioSection'
import { CoachingSection } from './CoachingSection'
import { SummaryLanguageSection } from './SummaryLanguageSection'
import { PersonalizationSection } from './PersonalizationSection'
import { ObjectionLibrarySection } from './ObjectionLibrarySection'
import { CalendarSection } from './CalendarSection'
import { CrmSection } from './CrmSection'
import { AppSection } from './AppSection'
import { AppearanceSection } from './AppearanceSection'
import { PrivacyDataPage } from './PrivacyDataPage'

const PAGE_CONTENT: Record<SettingsPageId, React.ComponentType> = {
  account: AccountSection,
  'ai-setup': ApiKeysSection,
  'ai-note-taker': AINoteTakerSection,
  'call-detection': DetectionSection,
  'recording-consent': RecordingConsentSection,
  audio: AudioSection,
  coaching: CoachingSection,
  'summary-language': SummaryLanguageSection,
  personalization: PersonalizationSection,
  'objection-library': ObjectionLibrarySection,
  calendar: CalendarSection,
  crm: CrmSection,
  app: AppSection,
  appearance: AppearanceSection,
  'privacy-data': PrivacyDataPage
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
  const [page, setPage] = useState<SettingsPageId>('account')
  const active = ALL_SETTINGS_PAGES.find((p) => p.id === page) ?? ALL_SETTINGS_PAGES[0]
  const PageContent = PAGE_CONTENT[page]
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
          <ul className="space-y-4">
            {SETTINGS_GROUPS.map((group, i) => (
              <li key={group.label ?? `group-${i}`}>
                {group.label && group.items.length > 1 && (
                  <p className="mb-1.5 px-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
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
