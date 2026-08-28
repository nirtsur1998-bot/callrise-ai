// M29 A1.1 — the anonymous telemetry id.
//
// INVARIANT (milestone brief): billing identity and telemetry identity are
// SEPARATE. This id is a fresh random UUID, created only once the user has
// opted in, stored in its own file, deleted when they opt out. It is never
// derived from, hashed from, or stored beside the account (the encrypted
// session blob `supabase-auth.json` is the only place the account lives on
// disk — docs/M29-audit.md §2.3). It is also NOT electron-updater's
// `.updaterId`: that one is sent to GitHub on every update check, and sharing
// it would let two unrelated data sets be joined.
//
// This module has no import path to auth.ts, app-settings.ts or anything
// that knows who the user is — the privacy red-check suite (A1.6) asserts
// that on the import graph.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ANON_ID_FILENAME = 'telemetry-id'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function anonIdPath(userDataDir: string): string {
  return join(userDataDir, ANON_ID_FILENAME)
}

/** Read the id if one exists and is well-formed; never creates. */
export function readAnonId(userDataDir: string): string | null {
  try {
    const path = anonIdPath(userDataDir)
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8').trim()
    return UUID_RE.test(raw) ? raw.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Create the id. Only the consent path (A1.3) may call this, and only after
 * the user has said yes. A malformed existing file is replaced — a corrupt
 * id is worse than a fresh one.
 */
export function getOrCreateAnonId(userDataDir: string): string {
  const existing = readAnonId(userDataDir)
  if (existing) return existing
  const id = randomUUID()
  const path = anonIdPath(userDataDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${id}\n`, { encoding: 'utf8', mode: 0o600 })
  return id
}

/** Opt-out deletes the id. A later opt-in mints a NEW one — no continuity across consent. */
export function deleteAnonId(userDataDir: string): void {
  try {
    const path = anonIdPath(userDataDir)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* best-effort; the file is also ignored when consent is off */
  }
}
