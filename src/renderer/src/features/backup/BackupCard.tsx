import {
  CloudCheck,
  CloudOff,
  AlertTriangle,
  Loader2,
  RefreshCw,
  ListChecks,
  CalendarDays,
  PhoneCall,
  Lock
} from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { useBackupStatus } from './useBackupStatus'

function agoLabel(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return 'a while ago' // corrupted/hand-edited timestamp — never crash the UI
  const secs = Math.max(0, Math.round((Date.now() - parsed) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function friendlyError(code: string, direction: 'backup' | 'restore'): string {
  switch (code) {
    case 'not-configured':
      return 'Cloud backup needs your account set up first.'
    case 'not-signed-in':
      return "You're not signed in, so nothing could sync."
    case 'ownership-mismatch':
      return 'This device is already backing up a different account. Sign in with that account to sync here.'
    default:
      return direction === 'backup'
        ? "The last backup didn't finish. It will retry automatically, or click Sync now."
        : "The last restore didn't finish, so recent changes from elsewhere may be missing. It will retry automatically, or click Sync now."
  }
}

const SYNCS: { icon: typeof ListChecks; label: string }[] = [
  { icon: ListChecks, label: 'Tasks' },
  { icon: CalendarDays, label: 'Calendar events' },
  { icon: PhoneCall, label: 'Call titles, summaries & coaching scores' }
]

const STAYS_LOCAL: string[] = [
  'Call recordings & transcripts',
  'Attached files',
  'Your Google Calendar connection'
]

/**
 * The backup/restore trust surface (M16 step 7): status, a manual "Sync now",
 * and a plain-language account of what does and doesn't leave this device.
 * Nothing here is a settings toggle — v1 backup is always on once signed in.
 */
export function BackupCard(): React.JSX.Element {
  const { status, syncing, loading, syncNow } = useBackupStatus()

  const lastSyncedAt = status?.lastSyncAt ?? status?.lastPushAt
  // Push and pull failures are tracked independently in the main process (a
  // successful push can no longer silently clear a genuine restore failure,
  // or vice versa), so each is only ever set while it's genuinely unresolved —
  // no staleness heuristic needed here.
  const pushError = status?.lastPushError
  const pullError = status?.lastPullError
  const hasError = Boolean(pushError || pullError)
  // A restore problem is the more important one to surface (it means changes
  // from another device may be missing), so prefer it when both are present.
  const errorMessage = pullError
    ? friendlyError(pullError, 'restore')
    : pushError
      ? friendlyError(pushError, 'backup')
      : null

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
              hasError ? 'bg-amber-500/15' : 'bg-accent-soft'
            )}
          >
            {hasError ? (
              <AlertTriangle className="h-5 w-5 text-amber-400" strokeWidth={2} />
            ) : (
              <CloudCheck className="h-5 w-5 text-accent" strokeWidth={2} />
            )}
          </div>
          <div>
            <p className="font-medium">Cloud backup</p>
            {loading ? (
              <p className="text-[13px] text-faint">Checking status…</p>
            ) : errorMessage ? (
              <p className="text-[13px] text-amber-400">{errorMessage}</p>
            ) : lastSyncedAt ? (
              <p className="text-[13px] text-muted">Backed up {agoLabel(lastSyncedAt)}</p>
            ) : (
              <p className="text-[13px] text-muted">Not backed up yet</p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void syncNow()}
          disabled={syncing}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium transition',
            syncing ? 'cursor-default text-muted' : 'text-ink hover:bg-elevated hover:text-ink'
          )}
        >
          {syncing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing…
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" /> Sync now
            </>
          )}
        </button>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 border-t border-line-soft pt-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">
            <CloudCheck className="h-3.5 w-3.5" /> Synced to your account
          </p>
          <ul className="space-y-1.5">
            {SYNCS.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-2 text-[13px] text-muted">
                <Icon className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
                {label}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">
            <CloudOff className="h-3.5 w-3.5" /> Stays only on this device
          </p>
          <ul className="space-y-1.5">
            {STAYS_LOCAL.map((label) => (
              <li key={label} className="flex items-center gap-2 text-[13px] text-muted">
                <Lock className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
                {label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-4 border-t border-line-soft pt-3 text-[12px] text-faint">
        Backups happen automatically in the background and restore on a new device when you sign in
        — your call recordings and transcripts never leave this Mac.
      </p>
    </Card>
  )
}
