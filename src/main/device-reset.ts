// BUG-022 — this device's local data is scoped to exactly one account (see
// backup.ts's ownership guard, which already refuses to CLOUD-SYNC a
// mismatched account's data but left everything else — calls, tasks,
// contacts, deals, knowledge, connected calendars, AI keys — fully visible
// to whoever signs in next on the same machine). backup.ts's own comment
// called this "a later 'reset this device' feature" — this is that feature,
// used only when a genuinely different account needs to use this device and
// explicitly confirms wiping what's here first (see auth.ts's ownership
// check, which is what routes here).
import { app } from 'electron'
import { join } from 'node:path'
import { rm, unlink } from 'node:fs/promises'
import { clearAllAiKeys } from './ai-keys'
import { disconnect as disconnectGoogle } from './google'
import { disconnect as disconnectOutlook } from './outlook'

const ACCOUNT_SCOPED_DIRS = [
  'calls', // includes attachments, stored under calls/<id>/files/
  'tasks',
  'events',
  'knowledge',
  'contacts',
  'deals',
  'objection-queue',
  'prep-briefs'
]

const ACCOUNT_SCOPED_FILES = [
  'backup-owner.json',
  'backup-state.json',
  'backup-pending-scrubs.json',
  'backup-pending-blob-deletes.json'
]

/** Deletes every local store scoped to the previous account, plus connected-
 *  service secrets (Google/Outlook OAuth, AI provider keys). Best-effort per
 *  item — one failure (a locked file) must not leave the rest untouched. */
export async function wipeDeviceLocalData(): Promise<void> {
  const userData = app.getPath('userData')
  for (const name of ACCOUNT_SCOPED_DIRS) {
    await rm(join(userData, name), { recursive: true, force: true }).catch(() => {})
  }
  for (const name of ACCOUNT_SCOPED_FILES) {
    await unlink(join(userData, name)).catch(() => {})
  }
  await clearAllAiKeys().catch(() => {})
  await disconnectGoogle().catch(() => {})
  await disconnectOutlook().catch(() => {})
}
