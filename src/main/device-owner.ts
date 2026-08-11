// Shared by auth.ts (blocks a mismatched account from signing in locally —
// BUG-022) and backup.ts (refuses to cloud-sync a mismatched account, and
// claims ownership on first sign-in). Kept in its own file rather than
// living in either: backup.ts already imports the signed-in client/user id
// from auth.ts, so putting this here avoids a circular import.
import { app } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

function ownerPath(): string {
  return join(app.getPath('userData'), 'backup-owner.json')
}

// This device's local data belongs to exactly ONE account (the app is
// single-user per machine). Pinned the first time an account signs in;
// checked before every cloud sync AND before a different account is ever
// allowed to sign in locally — otherwise a shared machine could upload, or
// simply show, account A's leftover local files under account B's identity.
// Clearing this belongs to the explicit "reset this device" flow
// (device-reset.ts), never to an implicit sign-out.
export async function readOwner(): Promise<string | null> {
  try {
    const v = JSON.parse(await fs.readFile(ownerPath(), 'utf8')) as { userId?: unknown }
    return typeof v.userId === 'string' && v.userId ? v.userId : null
  } catch {
    return null
  }
}

/**
 * Pin this device's data to `userId` if no owner is set yet. Uses an
 * EXCLUSIVE create ('wx'), so if two accounts ever race to claim a fresh
 * machine the FIRST writer wins atomically and later claims get EEXIST and
 * leave the winner intact — the "pin to first account" invariant is
 * race-proof, never a lost/torn claim.
 */
export async function claimOwnershipIfUnset(userId: string): Promise<void> {
  try {
    await fs.writeFile(ownerPath(), JSON.stringify({ userId }), { encoding: 'utf8', flag: 'wx' })
  } catch {
    /* already owned (EEXIST) or unwritable — leave any existing owner untouched */
  }
}
