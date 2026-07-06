import { User, Mic2, Sparkles, ShieldCheck, Lock, UserCircle } from 'lucide-react'
import { BackupCard } from '@renderer/features/backup/BackupCard'
import { SectionHeading } from './SectionHeading'
import { AccountSection } from './AccountSection'
import { AudioSection } from './AudioSection'
import { CoachingSection } from './CoachingSection'
import { RecordingConsentSection } from './RecordingConsentSection'
import { PersonalizationSection } from './PersonalizationSection'

export function SettingsView(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-2">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="mt-1.5 text-sm text-muted">Your account and how CallRise AI behaves.</p>
      </header>

      <SectionHeading icon={User} title="Account" />
      <AccountSection />

      <SectionHeading icon={Lock} title="Recording & consent" />
      <RecordingConsentSection />

      <SectionHeading icon={Mic2} title="Audio" />
      <AudioSection />

      <SectionHeading icon={Sparkles} title="AI & coaching" />
      <CoachingSection />

      <SectionHeading
        icon={UserCircle}
        title="Personalization"
        description="Feeds AI-generated summaries and coaching so they understand who you are."
      />
      <PersonalizationSection />

      <SectionHeading icon={ShieldCheck} title="Privacy & data" />
      <BackupCard />
    </div>
  )
}
