import {
  CloudCheck,
  AlertTriangle,
  Loader2,
  RefreshCw,
  ListChecks,
  CalendarDays,
  PhoneCall,
  Lock,
  MessagesSquare,
  Paperclip,
  BookOpen,
  SlidersHorizontal,
  Contact,
  Brain
} from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import {
  useAppSettings,
  type BackupSyncScope
} from '@renderer/features/settings/useAppSettings'
import { useBackupStatus, type SyncPhase } from './useBackupStatus'

/** Plain-language size + direction of the device-vs-server clock difference,
 *  e.g. "2 days ahead of" / "35 minutes behind". */
function describeSkew(skewMs: number | undefined): string {
  if (typeof skewMs !== 'number' || !Number.isFinite(skewMs)) return 'out of step with'
  const direction = skewMs > 0 ? 'ahead of' : 'behind'
  const mins = Math.round(Math.abs(skewMs) / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ${direction}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ${direction}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ${direction}`
}

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
    default:
      return direction === 'backup'
        ? "The last backup didn't finish. It will retry automatically, or click Sync now."
        : "The last restore didn't finish, so recent changes from elsewhere may be missing. It will retry automatically, or click Sync now."
  }
}

/** BUG-051 — "Sync now" runs a RESTORE (pulling other devices' changes down)
 *  and then a BACKUP (pushing this device's changes up). Both used to show
 *  one undifferentiated "Syncing…", so on a slow first-run restore there was
 *  no way to tell "your data is still arriving" from "your work is being
 *  saved" — the two have opposite implications if you quit mid-way. */
const PHASE_LABEL: Record<SyncPhase, string> = {
  waiting: 'Waiting for a background sync to finish…',
  restoring: 'Restoring changes from the cloud…',
  'backing-up': 'Backing up to the cloud…'
}

const PHASE_BUTTON_LABEL: Record<SyncPhase, string> = {
  waiting: 'Waiting…',
  restoring: 'Restoring…',
  'backing-up': 'Backing up…'
}

const ALWAYS_SYNCED: { icon: typeof ListChecks; label: string }[] = [
  { icon: ListChecks, label: 'Tasks' },
  { icon: CalendarDays, label: 'Calendar events' },
  { icon: PhoneCall, label: 'Call titles, summaries & coaching scores' }
]

// BUG-091 — DERIVED, never hand-listed. This was a literal five-key union
// while main's BackupSyncScope declared six. Because it was an independent
// copy rather than a derivation, TypeScript could not see the disagreement:
// `salesBrain` had NO writer anywhere in the renderer (setScope below is the
// only place syncScope is ever set), so the flag defaulted false, could not
// be turned on, and BOTH Sales Brain cloud paths — upload and restore — were
// unreachable from the product. Three bugs (BUG-087/088/089) were "fixed"
// inside functions nothing could call.
//
// Now a compile error if the two ever disagree again. A runtime pin in
// src/main/__tests__/sync-scope-no-drift.test.ts covers the main<->preload
// hop, which types alone cannot (preload re-declares the interface).
type SyncScopeKey = keyof BackupSyncScope

const OPTIONAL_ITEMS: { key: SyncScopeKey; icon: typeof ListChecks; label: string }[] = [
  { key: 'transcripts', icon: MessagesSquare, label: 'Call recordings & transcripts' },
  { key: 'attachments', icon: Paperclip, label: 'Attached files' },
  { key: 'knowledgeBase', icon: BookOpen, label: 'Knowledge Base entries' },
  {
    key: 'settingsPersonalization',
    icon: SlidersHorizontal,
    label: 'App settings & personalization'
  },
  { key: 'contacts', icon: Contact, label: 'Contacts & deals' },
  {
    key: 'salesBrain',
    icon: Brain,
    label: 'Sales Brain memories'
  }
]

/**
 * The backup/restore trust surface: status, a manual "Sync now", and a
 * plain-language, LIVE account of what does and doesn't leave this device —
 * Tasks/Calendar events/Call metadata always sync; four more categories are
 * opt-in toggles here, off by default. Google Calendar's connection is
 * deliberately NOT one of them — the OAuth token stays local always; a new
 * device gets a "reconnect" prompt instead (see CalendarSection.tsx).
 */
export function BackupCard(): React.JSX.Element {
  const { status, syncing, phase, loading, syncNow } = useBackupStatus()
  const { settings, update: updateSettings } = useAppSettings()
  const syncScope = settings.syncScope

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

  const setScope = (key: SyncScopeKey, value: boolean): void => {
    void updateSettings({ syncScope: { [key]: value } })
  }

  const syncedCount = OPTIONAL_ITEMS.filter((i) => syncScope[i.key]).length

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
              hasError ? 'bg-warning-soft' : 'bg-accent-soft'
            )}
          >
            {hasError ? (
              <AlertTriangle className="h-5 w-5 text-warning" strokeWidth={2} />
            ) : (
              <CloudCheck className="h-5 w-5 text-accent" strokeWidth={2} />
            )}
          </div>
          <div>
            <p className="font-medium">Cloud backup</p>
            {/* A sync is two different operations back to back, and which one
                is running matters: a slow restore means "changes from your
                other device are still arriving", a slow backup means "this
                device's work isn't saved yet". They used to look identical. */}
            {syncing ? (
              <p className="text-[13px] text-accent">{PHASE_LABEL[phase ?? 'waiting']}</p>
            ) : loading ? (
              <p className="text-[13px] text-faint">Checking status…</p>
            ) : errorMessage ? (
              <p className="text-[13px] text-warning">{errorMessage}</p>
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
              <Loader2 className="h-3.5 w-3.5 animate-spin" />{' '}
              {PHASE_BUTTON_LABEL[phase ?? 'waiting']}
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" /> Sync now
            </>
          )}
        </button>
      </div>

      <div className="mt-5 border-t border-line-soft pt-4">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">
          <CloudCheck className="h-3.5 w-3.5" /> Always synced to your account
        </p>
        <ul className="space-y-1.5">
          {ALWAYS_SYNCED.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-2 text-[13px] text-muted">
              <Icon className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
              {label}
            </li>
          ))}
        </ul>

        {/* One stable list — declared order never changes when a toggle
            flips, so rows don't jump between "synced"/"local" groupings. */}
        <p className="mt-4 mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">
          Optional — {syncedCount} of {OPTIONAL_ITEMS.length} synced
        </p>
        <ul className="space-y-1.5">
          {OPTIONAL_ITEMS.map(({ key, icon: Icon, label }) => (
            <li key={key} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="flex items-center gap-2 text-muted">
                <Icon className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
                {label}
              </span>
              <ToggleSwitch
                checked={syncScope[key]}
                onChange={(v) => setScope(key, v)}
                label={`Sync ${label} to the cloud`}
              />
            </li>
          ))}
          <li className="flex items-center gap-2 text-[13px] text-muted">
            <Lock className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
            Your Google Calendar connection — stays only on this device
          </li>
        </ul>
      </div>

      {syncScope.transcripts && (
        <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Call recordings & transcripts sync is ON — your buyer conversations are stored in your
          cloud account, not just this device.
        </p>
      )}

      {syncScope.knowledgeBase && (
        <p className="mt-4 text-[12px] text-faint">
          Knowledge Base sync includes objection scripts you approved from calls — approving a mined
          suggestion means its quotes sync with the rest of your library.
        </p>
      )}

      {status?.clockSkewWarning && (
        <div className="mt-4 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2">
          <p className="text-[12px] text-warning">
            This device&apos;s clock is about {describeSkew(status.clockSkewMs)} the real time. Your
            backups are still ordered correctly — that&apos;s handled on the server — but times
            shown in the app will look wrong until you fix the clock in your system date &amp; time
            settings.
          </p>
        </div>
      )}

      {(status?.conflictCount ?? 0) > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2">
          <p className="text-[12px] text-warning">
            {status!.conflictCount} conflicting {status!.conflictCount === 1 ? 'copy' : 'copies'}{' '}
            kept — the same record was edited on two devices at once; the losing version was saved
            next to your data instead of being discarded.
          </p>
          <button
            type="button"
            onClick={() => void window.api.backup.revealConflicts()}
            className="shrink-0 text-[12px] font-medium text-muted transition hover:text-ink"
          >
            {isMac ? 'Reveal in Finder' : 'Show in folder'}
          </button>
        </div>
      )}

      <p className="mt-4 border-t border-line-soft pt-3 text-[12px] text-faint">
        Backups happen automatically in the background and restore on a new device when you sign in.{' '}
        {syncScope.transcripts
          ? 'Call recordings and transcripts sync too, since you turned that on above.'
          : 'Your call recordings and transcripts never leave this computer unless you turn that on above.'}{' '}
        Your Google Calendar connection is never synced — reconnect it in one click on a new device
        instead.
      </p>
    </Card>
  )
}
