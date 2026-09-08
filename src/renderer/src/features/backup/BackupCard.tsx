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
  Brain,
  Sparkles
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
    case 'sandbox':
      // BUG-186 — a dev build on a profile COPY. Never reachable in a packaged
      // build; worded so a developer sees the refusal instead of a stale green.
      return 'This is a dev sandbox copy: cloud backup is switched off here on purpose (CALLRISE_SANDBOX_ALLOW_SYNC=1 to allow).'
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
  // Round five, 2026-09-08 — was "Call recordings & transcripts", and the word
  // "recordings" named a category that does not exist. Nothing writes call
  // audio to disk (the only two audio writers in the tree are the mic test and
  // Rise voice notes) and no payload or bucket carries any: callBackupPayload
  // and callFullBackupPayload are metadata, summary, coaching, segments,
  // bookmarks. So the label was wrong in BOTH directions — it promised an
  // upload that never happens, to a user who might rely on it after losing a
  // machine, while its off-state sentence promised the audio stays here and
  // the audio streams to Deepgram during every call (transcription.ts:487).
  // No guard caught this and none can: a label is a noun, not a claim, and the
  // falseness was that the noun named nothing.
  { key: 'transcripts', icon: MessagesSquare, label: 'Call transcripts' },
  { key: 'attachments', icon: Paperclip, label: 'Attached files' },
  { key: 'knowledgeBase', icon: BookOpen, label: 'Knowledge Base entries' },
  {
    key: 'settingsPersonalization',
    icon: SlidersHorizontal,
    label: 'App settings & personalization'
  },
  { key: 'contacts', icon: Contact, label: 'Contacts & deals' },
  // BUG-157 — Rise conversations had NO backup path at all, so every thread
  // was local-only and died with the machine. This row is not optional
  // decoration: sync-scope-no-drift.test.ts fails the build for any scope key
  // without one, because a key the renderer never writes can never be turned
  // on (that is BUG-091, and it left both Sales Brain cloud paths unreachable
  // while three bugs were 'fixed' inside functions nothing could call).
  { key: 'riseConversations', icon: Sparkles, label: 'Rise conversations' },
  {
    key: 'salesBrain',
    icon: Brain,
    label: 'Sales Brain memories'
  }
]

/**
 * The backup/restore trust surface: status, a manual "Sync now", and a
 * plain-language, LIVE account of what does and doesn't leave this device —
 * Tasks/Calendar events/Call metadata always sync; SEVEN more categories are
 * toggles here. It said "four" for months while OPTIONAL_ITEMS above listed
 * seven, and nothing checked the prose against the array. Five of the seven
 * are off for everyone; riseConversations and salesBrain are on for a FRESH
 * profile and off for an install predating those keys (BUG-211).
 * Google Calendar's connection is
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

  // BUG-214 — the count has to agree with the rows. A category whose upload is
  // blocked by another toggle is not synced, and counting it made "2 of 7
  // synced" true of the switches and false of the account.
  const syncedCount = OPTIONAL_ITEMS.filter(
    (i) => syncScope[i.key] && !(i.key === 'salesBrain' && !syncScope.transcripts)
  ).length

  // BUG-203 — categories the user switched OFF whose removal has not succeeded
  // yet. Named with the same words as the toggles above, so a user reads back
  // the thing they switched off rather than an internal key.
  //
  // Shown only from the SECOND consecutive failure, so one offline push does
  // not accuse the app of losing someone's data. `lastScrubErrorAt` older than
  // the last push means the failure did not recur.
  const pendingScrubs = status?.pendingScrubs ?? []
  const scrubFailedTwice =
    pendingScrubs.length > 0 &&
    Boolean(status?.lastScrubErrorAt) &&
    Boolean(status?.lastPushAt) &&
    new Date(status!.lastScrubErrorAt!).getTime() >= new Date(status!.lastPushAt!).getTime()
  // BUG-216 — signed out, a scrub cannot run at all: pushAll returns before
  // the drain is reached. So it is not "retrying", it is stopped, and waiting
  // for a second consecutive failure would wait for ever. Shown immediately.
  const scrubStoppedBySignOut = pendingScrubs.length > 0 && status?.signedIn === false
  const pendingScrubLabels =
    scrubFailedTwice || scrubStoppedBySignOut
      ? pendingScrubs
          .map((k) => OPTIONAL_ITEMS.find((i) => i.key === k)?.label ?? k)
          .join(', ')
          .toLowerCase()
      : null

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
            ) : pendingScrubLabels ? (
              // BUG-203. This takes the primary line rather than sitting below
              // the fold, because "we did not remove what you asked us to
              // remove" outranks "backed up just now" — and because the old
              // behaviour was to show the reassuring line and nothing else,
              // forever, while the erase failed on every single push.
              <p className="text-[13px] text-warning">
                {scrubStoppedBySignOut
                  ? `Sign in to finish removing ${pendingScrubLabels} from your account`
                  : `Still removing ${pendingScrubLabels} from your account`}
              </p>
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
        {/* BUG-223 — the scope of these switches, said once above all seven.
            Each row is named for a CATEGORY ("Call recordings & transcripts"),
            under a heading about what leaves this device, so a user who turns
            one off has expressed a view about that category and the app
            honours it for exactly one of the two places the data goes.
            syncScope governs Supabase and nothing else: a grep for it across
            live-cue.ts, coach.ts, summarize.ts and memory/extraction.ts
            returns nothing, correctly, because gating an AI feature on a
            BACKUP preference would be the wrong coupling.
            The founder's decision was to disclose rather than gate: "AI reads
            your calls" is the product, and a toggle implying "send my
            transcripts but not really" would be worse than an honest
            sentence. Placed above the list rather than on one row, because
            annotating one would leave the other six making the same implicit
            claim. */}
        <p className="mb-2 text-[12px] text-faint">
          These control your backup only. Transcripts also go to your AI provider whenever a feature
          reads a call.
        </p>
        <ul className="space-y-1.5">
          {OPTIONAL_ITEMS.map(({ key, icon: Icon, label }) => {
            // BUG-214 — a row whose switch is ON while nothing is being
            // uploaded is the readout lying, and this one was introduced by
            // the fix directly above it: the Sales Brain push now requires
            // BOTH its own toggle and the transcripts toggle (backup.ts), and
            // this list was not told. On a fresh profile that is the SHIPPED
            // state — salesBrain defaults on, transcripts defaults off — so
            // the card read "Sales Brain memories: on" while the brain had
            // never left the machine and never would.
            //
            // Blocked rather than forced off: the user's preference is real
            // and is honoured the moment transcripts goes on. What is wrong is
            // showing a preference as if it were an outcome.
            const blocked = key === 'salesBrain' && !syncScope.transcripts
            return (
              <li key={key} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="flex items-center gap-2 text-muted">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
                  {label}
                  {blocked && (
                    <span className="text-[11px] text-faint" data-testid="scope-blocked">
                      not syncing while transcripts are off
                    </span>
                  )}
                </span>
                <ToggleSwitch
                  checked={syncScope[key] && !blocked}
                  onChange={(v) => setScope(key, v)}
                  label={`Sync ${label} to the cloud`}
                />
              </li>
            )
          })}
          <li className="flex items-center gap-2 text-[13px] text-muted">
            <Lock className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
            Your Google Calendar connection — stays only on this device
          </li>
        </ul>
      </div>

      {syncScope.transcripts && (
        <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Call transcripts sync is ON — your buyer conversations are stored in your cloud account,
          not just this device.
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

      {pendingScrubLabels && (
        <div className="mt-4 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2">
          <p className="text-[12px] text-warning">
            {scrubStoppedBySignOut ? (
              <>
                You switched off {pendingScrubLabels}, and the copy already in your account has not
                been removed. Removing it needs you signed in, so nothing is being retried while you
                are signed out. That data is still there.
              </>
            ) : (
              <>
                You switched off {pendingScrubLabels}, and removing the copy already in your account
                has not succeeded yet. We keep trying on every backup. Until it does, that data is
                still there.
              </>
            )}
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
        {/* Round five. The OFF branch used to read "Your call recordings and
            transcripts never leave this computer unless you turn that on
            above." Both halves were false: there are no call recordings, and
            the transcript reaches the user's AI provider on every summary,
            coaching run, task extraction, live cue and Sales Brain extraction
            regardless of this toggle. A locality PROMISE has been replaced
            with what actually happens — the one rename in this batch that
            changes meaning rather than wording. */}
        {syncScope.transcripts
          ? 'Your transcripts sync too, since you turned that on above.'
          : "Your transcripts aren't included unless you turn that on above. Your AI provider still receives them whenever a feature reads a call."}{' '}
        Your Google Calendar connection is never synced — reconnect it in one click on a new device
        instead.
      </p>
    </Card>
  )
}
