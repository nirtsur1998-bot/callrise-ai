import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'

/** A comment left on a contact — either the rep's own note, or an AI-drafted
 *  one from a linked call (opt-in, see CrmSettings.autoGenerateNotes). */
export interface ContactComment {
  id: string
  text: string
  createdAt: string
  source: 'user' | 'ai'
}

/** A saved contact (what's stored on disk: one JSON file per contact). */
export interface Contact {
  id: string
  name: string
  /** Free-text company name — not a separate entity yet (a later CRM phase). */
  company?: string
  /** The rep's own customer/account number for this person (free text). */
  cid?: string
  /** When this person became a customer (date-only ISO string). Distinct from
   *  createdAt, which is when the record was saved in the app. */
  registeredAt?: string
  /** ISO 3166-1 alpha-2 country of the client, e.g. "US". */
  country?: string
  email?: string
  /** ISO 3166-1 alpha-2 country the phone number's dial code belongs to. */
  phoneCountry?: string
  /** National number only (no dial code — that's phoneCountry). */
  phone?: string
  notes?: string
  createdAt: string // ISO timestamp
  /** Last modification (create or any edit), ISO timestamp — the ordering key a
   *  future cloud backup would use for "newest wins". Backfilled from createdAt
   *  for contacts saved before this field existed. */
  updatedAt: string
  /** Tombstone: a deleted contact is kept (not erased) so the deletion can
   *  propagate to a future cloud backup. Hidden from every normal listing. */
  deleted?: boolean
  comments?: ContactComment[]
}

/** Fields the renderer may send when creating a contact. */
export interface ContactCreateInput {
  name?: unknown
  company?: unknown
  cid?: unknown
  registeredAt?: unknown
  country?: unknown
  email?: unknown
  phoneCountry?: unknown
  phone?: unknown
  notes?: unknown
}

/** Fields the renderer may change. A key present with `null` clears that
 *  optional field; a key that's absent leaves the existing value untouched. */
export interface ContactUpdateInput {
  name?: unknown
  company?: unknown
  cid?: unknown
  registeredAt?: unknown
  country?: unknown
  email?: unknown
  phoneCountry?: unknown
  phone?: unknown
  notes?: unknown
}

// Ids are used to build file paths, so they must be tightly constrained
// (no "../", no slashes) to prevent path traversal.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
// ISO 3166-1 alpha-2, case-insensitive on input, stored uppercase.
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/
const MAX_NAME = 200
const MAX_COMPANY = 200
const MAX_CID = 100
const MAX_EMAIL = 320
const MAX_PHONE = 40
const MAX_NOTES = 2000

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** Accept a 2-letter country code; anything else becomes undefined. The full
 *  country list lives in the renderer (this only constrains shape/format). */
function sanitizeCountryCode(value: unknown): string | undefined {
  return typeof value === 'string' && COUNTRY_CODE_RE.test(value) ? value.toUpperCase() : undefined
}

/** Accept a date-only ISO string (yyyy-mm-dd); anything unparseable becomes undefined. */
function sanitizeDateOnly(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = Date.parse(value)
  if (Number.isNaN(t)) return undefined
  return new Date(t).toISOString().slice(0, 10)
}

/** Trim, collapse newlines, and bound a free-text string. Empty -> undefined. */
function sanitizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max)
  return clean ? clean : undefined
}

/** Like sanitizeOptionalText but PRESERVES newlines — for the multi-line
 *  notes textarea. Collapsing newlines silently flattened users' notes into
 *  one run-on line on every save AND read. Normalizes CRLF, caps blank runs. */
function sanitizeMultilineText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
  return clean ? clean : undefined
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeContact(dir: string, contact: Contact): Promise<void> {
  await writeJsonAtomic(join(dir, `${contact.id}.json`), contact)
}

/** Coerce an untrusted parsed object into a clean Contact, or null if unusable. */
function sanitizeContactRecord(value: unknown): Contact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const createdAt =
    typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
      ? v.createdAt
      : new Date().toISOString()
  // Preserve updatedAt across the read/write round-trip; backfill from createdAt
  // for contacts written before this field existed.
  const updatedAt =
    typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt))
      ? v.updatedAt
      : createdAt
  // A tombstone must carry NO personal data — a deleted contact's name, email,
  // phone, and notes must not persist on disk or reach the cloud (mirrors
  // deleteCall, which strips the transcript from call tombstones). Enforced on
  // EVERY read so tombstones written before this rule are scrubbed too.
  if (v.deleted === true) {
    return { id: v.id, name: 'Deleted contact', createdAt, updatedAt, deleted: true }
  }
  const name = sanitizeOptionalText(v.name, MAX_NAME)
  if (!name) return null
  return {
    id: v.id,
    name,
    company: sanitizeOptionalText(v.company, MAX_COMPANY),
    cid: sanitizeOptionalText(v.cid, MAX_CID),
    registeredAt: sanitizeDateOnly(v.registeredAt),
    country: sanitizeCountryCode(v.country),
    email: sanitizeOptionalText(v.email, MAX_EMAIL),
    phoneCountry: sanitizeCountryCode(v.phoneCountry),
    phone: sanitizeOptionalText(v.phone, MAX_PHONE),
    notes: sanitizeMultilineText(v.notes, MAX_NOTES),
    createdAt,
    updatedAt
  }
}

export async function createContact(
  dir: string,
  input: ContactCreateInput
): Promise<Contact | null> {
  const name = sanitizeOptionalText(input?.name, MAX_NAME)
  if (!name) return null
  await ensureDir(dir)
  const now = new Date().toISOString()
  const contact: Contact = {
    id: randomUUID(),
    name,
    company: sanitizeOptionalText(input?.company, MAX_COMPANY),
    cid: sanitizeOptionalText(input?.cid, MAX_CID),
    registeredAt: sanitizeDateOnly(input?.registeredAt),
    country: sanitizeCountryCode(input?.country),
    email: sanitizeOptionalText(input?.email, MAX_EMAIL),
    phoneCountry: sanitizeCountryCode(input?.phoneCountry),
    phone: sanitizeOptionalText(input?.phone, MAX_PHONE),
    notes: sanitizeMultilineText(input?.notes, MAX_NOTES),
    createdAt: now,
    updatedAt: now
  }
  await writeContact(dir, contact)
  return contact
}

export async function listContacts(
  dir: string,
  opts?: { includeDeleted?: boolean }
): Promise<Contact[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const contacts: Contact[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const contact = sanitizeContactRecord(JSON.parse(raw))
      // Tombstones stay hidden from the app; a future backup reads them via includeDeleted.
      if (contact && (opts?.includeDeleted || !contact.deleted)) contacts.push(contact)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  // Alphabetical by name as a stable default; the renderer applies its own ordering.
  contacts.sort((a, b) => a.name.localeCompare(b.name))
  return contacts
}

export async function getContact(dir: string, id: string): Promise<Contact | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    const contact = sanitizeContactRecord(JSON.parse(raw))
    return contact && !contact.deleted ? contact : null // a tombstone reads as "gone"
  } catch {
    return null
  }
}

// ── Per-contact write lock ────────────────────────────────────────────────────
// updateContact/deleteContact are read-then-write (getContact → mutate →
// writeContact), so two concurrent IPC calls for the SAME contact id could each
// read the old record and the second write would silently drop the first's
// changes. This chains all mutations for a given id so each one runs after the
// previous settles. (Deliberately duplicated from tasks-fs.ts to keep this file
// self-contained.)
const contactLocks = new Map<string, Promise<unknown>>()

function withContactLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = contactLocks.get(id) ?? Promise.resolve()
  const result = prev.then(fn, fn) // run after prev settles, regardless of its outcome
  const gate = result.then(
    () => {},
    () => {}
  )
  contactLocks.set(id, gate)
  void gate.finally(() => {
    if (contactLocks.get(id) === gate) contactLocks.delete(id) // drop only if we're still the tail
  })
  return result
}

export function updateContact(
  dir: string,
  id: string,
  patch: ContactUpdateInput
): Promise<Contact | null> {
  if (!isSafeId(id)) return Promise.resolve(null)
  return withContactLock(id, () => updateContactUnlocked(dir, id, patch))
}

async function updateContactUnlocked(
  dir: string,
  id: string,
  patch: ContactUpdateInput
): Promise<Contact | null> {
  const contact = await getContact(dir, id)
  if (!contact) return null
  if (!patch || typeof patch !== 'object') return contact

  if ('name' in patch) {
    const next = sanitizeOptionalText(patch.name, MAX_NAME)
    if (next) contact.name = next // never blank out the name
  }
  if ('company' in patch) contact.company = sanitizeOptionalText(patch.company, MAX_COMPANY)
  if ('cid' in patch) contact.cid = sanitizeOptionalText(patch.cid, MAX_CID)
  if ('registeredAt' in patch) contact.registeredAt = sanitizeDateOnly(patch.registeredAt)
  if ('country' in patch) contact.country = sanitizeCountryCode(patch.country)
  if ('email' in patch) contact.email = sanitizeOptionalText(patch.email, MAX_EMAIL)
  if ('phoneCountry' in patch) contact.phoneCountry = sanitizeCountryCode(patch.phoneCountry)
  if ('phone' in patch) contact.phone = sanitizeOptionalText(patch.phone, MAX_PHONE)
  if ('notes' in patch) contact.notes = sanitizeMultilineText(patch.notes, MAX_NOTES)

  contact.updatedAt = new Date().toISOString() // mark modified (future backup ordering key)

  try {
    await writeContact(dir, contact)
  } catch {
    return null
  }
  return contact
}

export function deleteContact(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return Promise.resolve({ ok: false })
  return withContactLock(id, () => deleteContactUnlocked(dir, id))
}

async function deleteContactUnlocked(dir: string, id: string): Promise<{ ok: boolean }> {
  const contact = await getContact(dir, id)
  if (!contact) return { ok: false } // missing or already a tombstone
  // Tombstone instead of erase, so the deletion can propagate to a future
  // backup — but stripped of ALL personal data (name, email, phone, notes):
  // deleting a contact must not leave their PII on disk or push it to the
  // cloud with the tombstone.
  const tombstone: Contact = {
    id: contact.id,
    name: 'Deleted contact',
    createdAt: contact.createdAt,
    updatedAt: new Date().toISOString(),
    deleted: true
  }
  try {
    await writeContact(dir, tombstone)
  } catch {
    return { ok: false }
  }
  return { ok: true }
}

const MAX_COMMENT = 2000

/** Leave a comment on a contact — either the rep's own note (source 'user')
 *  or an AI-drafted one from a linked call (source 'ai', see
 *  CrmSettings.autoGenerateNotes). */
export function addComment(
  dir: string,
  id: string,
  text: unknown,
  source: 'user' | 'ai' = 'user'
): Promise<Contact | null> {
  if (!isSafeId(id)) return Promise.resolve(null)
  return withContactLock(id, async () => {
    const contact = await getContact(dir, id)
    if (!contact) return null
    const clean = sanitizeMultilineText(text, MAX_COMMENT)
    if (!clean) return contact // nothing to add
    const comment: ContactComment = {
      id: randomUUID(),
      text: clean,
      createdAt: new Date().toISOString(),
      source
    }
    contact.comments = [...(contact.comments ?? []), comment]
    contact.updatedAt = new Date().toISOString()
    try {
      await writeContact(dir, contact)
    } catch {
      return null
    }
    return contact
  })
}

export function removeComment(dir: string, id: string, commentId: string): Promise<Contact | null> {
  if (!isSafeId(id)) return Promise.resolve(null)
  return withContactLock(id, async () => {
    const contact = await getContact(dir, id)
    if (!contact) return null
    contact.comments = (contact.comments ?? []).filter((c) => c.id !== commentId)
    contact.updatedAt = new Date().toISOString()
    try {
      await writeContact(dir, contact)
    } catch {
      return null
    }
    return contact
  })
}

/**
 * ID-PRESERVING importer for cloud-backup restore, mirroring importTask in
 * tasks-fs.ts. Keeps the original id (idempotent re-pulls), re-sanitizes
 * fully (a tampered cloud payload can't plant an unsafe id/path or malformed
 * fields), and — with `onlyIfNewer` — re-reads the CURRENT on-disk record at
 * write time so a local edit/delete landing mid-restore can't be clobbered.
 */
export async function importContact(
  dir: string,
  payload: unknown,
  opts?: { onlyIfNewer?: boolean }
): Promise<Contact | null> {
  const contact = sanitizeContactRecord(payload)
  if (!contact) return null
  // Serialize with the regular mutators: without the lock, the read-compare-
  // write below races a concurrent local edit, and a stale cloud copy could
  // overwrite the fresher record the "onlyIfNewer" check is meant to protect.
  return withContactLock(contact.id, async () => {
    if (opts?.onlyIfNewer) {
      try {
        const raw = await fs.readFile(join(dir, `${contact.id}.json`), 'utf8')
        const current = sanitizeContactRecord(JSON.parse(raw))
        if (current && Date.parse(current.updatedAt) >= Date.parse(contact.updatedAt)) return null
      } catch {
        /* no current record (or unreadable) — proceed with the import */
      }
    }
    await ensureDir(dir)
    try {
      await writeContact(dir, contact)
    } catch {
      return null
    }
    return contact
  })
}
