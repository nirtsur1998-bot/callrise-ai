import { BackupCard } from '@renderer/features/backup/BackupCard'

export function SettingsView(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="mt-1.5 text-sm text-muted">Your account and how your data is kept.</p>
      </header>

      <BackupCard />
    </div>
  )
}
