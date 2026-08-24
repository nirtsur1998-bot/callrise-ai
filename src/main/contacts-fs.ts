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
  /** E.164 (e.g. "+14155551234"), computed by the renderer from
   *  phoneCountry+phone at write time (it owns the country→dial-code table;
   *  main only validates the format) — the join key M19 Task 2's
   *  phone-based contact matching uses. */
  phoneE164?: string
  notes?: string

  // --- KYC / Business (M19) ---
  /** Industry classification. */
  industry?: string
  /** Company size (e.g., "1-10", "11-50", "51-250", "250+"). */
  companySize?: string
  /** Website URL. */
  website?: string
  /** Registration number, VAT ID, or similar. */
  registrationNumber?: string
  /** Verification status of the company (e.g., "verified", "pending", "failed"). */
  verificationStatus?: string
  /** Job title / role. */
  title?: string
  /** Primary contact's decision-making authority level. */
  decisionAuthority?: string
  /** Other stakeholders involved (free text). */
  otherStakeholders?: string

  // --- Deal Context (M19) ---
  /** Deal value associated with this contact. */
  dealValue?: number
  /** Pipeline stage (links to deal-stages if a deal exists). */
  pipelineStage?: string
  /** Source of lead (e.g., "inbound", "cold outreach", "referral"). */
  leadSource?: string
  /** Budget indication for this prospect. */
  budgetIndication?: string
  /** Timeline/urgency (e.g., "Q1", "ASAP", "TBD"). */
  timeline?: string
  /** Competitors in play (free text). */
  competitors?: string
  /** Known objections, stored as free text. */
  knownObjections?: string
  /** Their current tooling / solutions in use. */
  currentTooling?: string
  /** Last contact date as ISO string (yyyy-mm-dd). */
  lastContactDate?: string

  // --- Personal / Soft (M19) ---
  /** Preferred language for communication. */
  preferredLanguage?: string
  /** Communication style (e.g., "formal", "casual", "email-first"). */
  communicationStyle?: string
  /** Timezone (IANA format, e.g., "America/New_York"). */
  timezone?: string
  /** Personal notes ("has two kids", "mentions cycling"). */
  personalNotes?: string
  /** Large free-text field: "Anything else the AI should know before I meet this person". */
  briefingNotes?: string

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
  phoneE164?: unknown
  notes?: unknown
  industry?: unknown
  companySize?: unknown
  website?: unknown
  registrationNumber?: unknown
  verificationStatus?: unknown
  title?: unknown
  decisionAuthority?: unknown
  otherStakeholders?: unknown
  dealValue?: unknown
  pipelineStage?: unknown
  leadSource?: unknown
  budgetIndication?: unknown
  timeline?: unknown
  competitors?: unknown
  knownObjections?: unknown
  currentTooling?: unknown
  lastContactDate?: unknown
  preferredLanguage?: unknown
  communicationStyle?: unknown
  timezone?: unknown
  personalNotes?: unknown
  briefingNotes?: unknown
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
  phoneE164?: unknown
  notes?: unknown
  industry?: unknown
  companySize?: unknown
  website?: unknown
  registrationNumber?: unknown
  verificationStatus?: unknown
  title?: unknown
  decisionAuthority?: unknown
  otherStakeholders?: unknown
  dealValue?: unknown
  pipelineStage?: unknown
  leadSource?: unknown
  budgetIndication?: unknown
  timeline?: unknown
  competitors?: unknown
  knownObjections?: unknown
  currentTooling?: unknown
  lastContactDate?: unknown
  preferredLanguage?: unknown
  communicationStyle?: unknown
  timezone?: unknown
  personalNotes?: unknown
  briefingNotes?: unknown
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
const MAX_SHORT_TEXT = 100
const MAX_LONG_TEXT = 1000
const MAX_BRIEFING = 5000

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
/** Hard cap on comments per contact, so one contact file cannot grow without bound. */
const MAX_COMMENTS = 500

/**
 * BUG-095 (founder-reported 2026-08-24). `comments` was missing from
 * sanitizeContactRecord's closed object literal, so every read stripped it:
 * a posted comment was written to disk, shown once from the return value, and
 * gone on the next read — and because updateContact is read-then-write, the
 * next unrelated edit erased it from disk for good.
 *
 * Validated element by element rather than passed through: this array comes
 * off disk, and a contact file is user-writable. A malformed entry is dropped,
 * never allowed through as-is. MAX_COMMENTS bounds the array so a runaway
 * writer cannot make a contact file unbounded.
 */
function sanitizeComments(value: unknown): ContactComment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ContactComment[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    const text = sanitizeMultilineText(c.text, MAX_COMMENT)
    if (!text) continue // a comment with no text is not a comment
    if (!isSafeId(c.id)) continue
    const createdAt =
      typeof c.createdAt === 'string' && !Number.isNaN(Date.parse(c.createdAt))
        ? c.createdAt
        : new Date().toISOString()
    out.push({
      id: c.id as string,
      text,
      createdAt,
      source: c.source === 'ai' ? 'ai' : 'user'
    })
    if (out.length >= MAX_COMMENTS) break
  }
  return out.length > 0 ? out : undefined
}

function sanitizeMultilineText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
  return clean ? clean : undefined
}

/** Validate and bound a currency amount. */
function sanitizeValue(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 100) / 100
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Trim + lowercase, so a calendar attendee's email ("Jane@Acme.com") and a
 *  hand-typed one ("jane@acme.com") always match on the same normalized
 *  string — the join key M19 Task 2's calendar/contact matching relies on.
 *  Rejects anything that doesn't look like an email at all. */
function sanitizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim().toLowerCase()
  return EMAIL_RE.test(clean) ? clean.slice(0, MAX_EMAIL) : undefined
}

// ITU-T E.164: a leading '+', then 7-15 digits, first digit 1-9 (no leading
// zero after the '+'). Format ONLY is validated here — the country->dial-code
// table (needed to actually PRODUCE this from phoneCountry+phone) lives in the
// renderer (src/renderer/src/lib/countries.ts), so main never duplicates it.
const E164_RE = /^\+[1-9]\d{6,14}$/
function sanitizePhoneE164(value: unknown): string | undefined {
  return typeof value === 'string' && E164_RE.test(value.trim()) ? value.trim() : undefined
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
    email: sanitizeEmail(v.email),
    phoneCountry: sanitizeCountryCode(v.phoneCountry),
    phone: sanitizeOptionalText(v.phone, MAX_PHONE),
    phoneE164: sanitizePhoneE164(v.phoneE164),
    notes: sanitizeMultilineText(v.notes, MAX_NOTES),
    // BUG-095: without this line every read silently dropped the rep's
    // comments and AI-drafted notes.
    comments: sanitizeComments(v.comments),
    industry: sanitizeOptionalText(v.industry, MAX_SHORT_TEXT),
    companySize: sanitizeOptionalText(v.companySize, MAX_SHORT_TEXT),
    website: sanitizeOptionalText(v.website, MAX_LONG_TEXT),
    registrationNumber: sanitizeOptionalText(v.registrationNumber, MAX_SHORT_TEXT),
    verificationStatus: sanitizeOptionalText(v.verificationStatus, MAX_SHORT_TEXT),
    title: sanitizeOptionalText(v.title, MAX_SHORT_TEXT),
    decisionAuthority: sanitizeOptionalText(v.decisionAuthority, MAX_SHORT_TEXT),
    otherStakeholders: sanitizeMultilineText(v.otherStakeholders, MAX_LONG_TEXT),
    dealValue: sanitizeValue(v.dealValue),
    pipelineStage: sanitizeOptionalText(v.pipelineStage, MAX_SHORT_TEXT),
    leadSource: sanitizeOptionalText(v.leadSource, MAX_SHORT_TEXT),
    budgetIndication: sanitizeOptionalText(v.budgetIndication, MAX_SHORT_TEXT),
    timeline: sanitizeOptionalText(v.timeline, MAX_SHORT_TEXT),
    competitors: sanitizeMultilineText(v.competitors, MAX_LONG_TEXT),
    knownObjections: sanitizeMultilineText(v.knownObjections, MAX_LONG_TEXT),
    currentTooling: sanitizeMultilineText(v.currentTooling, MAX_LONG_TEXT),
    lastContactDate: sanitizeDateOnly(v.lastContactDate),
    preferredLanguage: sanitizeOptionalText(v.preferredLanguage, MAX_SHORT_TEXT),
    communicationStyle: sanitizeOptionalText(v.communicationStyle, MAX_SHORT_TEXT),
    timezone: sanitizeOptionalText(v.timezone, MAX_SHORT_TEXT),
    personalNotes: sanitizeMultilineText(v.personalNotes, MAX_LONG_TEXT),
    briefingNotes: sanitizeMultilineText(v.briefingNotes, MAX_BRIEFING),
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
    email: sanitizeEmail(input?.email),
    phoneCountry: sanitizeCountryCode(input?.phoneCountry),
    phone: sanitizeOptionalText(input?.phone, MAX_PHONE),
    phoneE164: sanitizePhoneE164(input?.phoneE164),
    notes: sanitizeMultilineText(input?.notes, MAX_NOTES),
    industry: sanitizeOptionalText(input?.industry, MAX_SHORT_TEXT),
    companySize: sanitizeOptionalText(input?.companySize, MAX_SHORT_TEXT),
    website: sanitizeOptionalText(input?.website, MAX_LONG_TEXT),
    registrationNumber: sanitizeOptionalText(input?.registrationNumber, MAX_SHORT_TEXT),
    verificationStatus: sanitizeOptionalText(input?.verificationStatus, MAX_SHORT_TEXT),
    title: sanitizeOptionalText(input?.title, MAX_SHORT_TEXT),
    decisionAuthority: sanitizeOptionalText(input?.decisionAuthority, MAX_SHORT_TEXT),
    otherStakeholders: sanitizeMultilineText(input?.otherStakeholders, MAX_LONG_TEXT),
    dealValue: sanitizeValue(input?.dealValue),
    pipelineStage: sanitizeOptionalText(input?.pipelineStage, MAX_SHORT_TEXT),
    leadSource: sanitizeOptionalText(input?.leadSource, MAX_SHORT_TEXT),
    budgetIndication: sanitizeOptionalText(input?.budgetIndication, MAX_SHORT_TEXT),
    timeline: sanitizeOptionalText(input?.timeline, MAX_SHORT_TEXT),
    competitors: sanitizeMultilineText(input?.competitors, MAX_LONG_TEXT),
    knownObjections: sanitizeMultilineText(input?.knownObjections, MAX_LONG_TEXT),
    currentTooling: sanitizeMultilineText(input?.currentTooling, MAX_LONG_TEXT),
    lastContactDate: sanitizeDateOnly(input?.lastContactDate),
    preferredLanguage: sanitizeOptionalText(input?.preferredLanguage, MAX_SHORT_TEXT),
    communicationStyle: sanitizeOptionalText(input?.communicationStyle, MAX_SHORT_TEXT),
    timezone: sanitizeOptionalText(input?.timezone, MAX_SHORT_TEXT),
    personalNotes: sanitizeMultilineText(input?.personalNotes, MAX_LONG_TEXT),
    briefingNotes: sanitizeMultilineText(input?.briefingNotes, MAX_BRIEFING),
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
  const results = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file): Promise<Contact | null> => {
        try {
          const raw = await fs.readFile(join(dir, file), 'utf8')
          const contact = sanitizeContactRecord(JSON.parse(raw))
          // Tombstones stay hidden from the app; a future backup reads them via includeDeleted.
          return contact && (opts?.includeDeleted || !contact.deleted) ? contact : null
        } catch {
          return null // skip unreadable / corrupt file
        }
      })
  )
  const contacts = results.filter((c): c is Contact => c !== null)
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
  if ('email' in patch) contact.email = sanitizeEmail(patch.email)
  if ('phoneCountry' in patch) contact.phoneCountry = sanitizeCountryCode(patch.phoneCountry)
  if ('phone' in patch) contact.phone = sanitizeOptionalText(patch.phone, MAX_PHONE)
  if ('phoneE164' in patch) contact.phoneE164 = sanitizePhoneE164(patch.phoneE164)
  if ('notes' in patch) contact.notes = sanitizeMultilineText(patch.notes, MAX_NOTES)
  if ('industry' in patch) contact.industry = sanitizeOptionalText(patch.industry, MAX_SHORT_TEXT)
  if ('companySize' in patch) contact.companySize = sanitizeOptionalText(patch.companySize, MAX_SHORT_TEXT)
  if ('website' in patch) contact.website = sanitizeOptionalText(patch.website, MAX_LONG_TEXT)
  if ('registrationNumber' in patch) contact.registrationNumber = sanitizeOptionalText(patch.registrationNumber, MAX_SHORT_TEXT)
  if ('verificationStatus' in patch) contact.verificationStatus = sanitizeOptionalText(patch.verificationStatus, MAX_SHORT_TEXT)
  if ('title' in patch) contact.title = sanitizeOptionalText(patch.title, MAX_SHORT_TEXT)
  if ('decisionAuthority' in patch) contact.decisionAuthority = sanitizeOptionalText(patch.decisionAuthority, MAX_SHORT_TEXT)
  if ('otherStakeholders' in patch) contact.otherStakeholders = sanitizeMultilineText(patch.otherStakeholders, MAX_LONG_TEXT)
  if ('dealValue' in patch) contact.dealValue = sanitizeValue(patch.dealValue)
  if ('pipelineStage' in patch) contact.pipelineStage = sanitizeOptionalText(patch.pipelineStage, MAX_SHORT_TEXT)
  if ('leadSource' in patch) contact.leadSource = sanitizeOptionalText(patch.leadSource, MAX_SHORT_TEXT)
  if ('budgetIndication' in patch) contact.budgetIndication = sanitizeOptionalText(patch.budgetIndication, MAX_SHORT_TEXT)
  if ('timeline' in patch) contact.timeline = sanitizeOptionalText(patch.timeline, MAX_SHORT_TEXT)
  if ('competitors' in patch) contact.competitors = sanitizeMultilineText(patch.competitors, MAX_LONG_TEXT)
  if ('knownObjections' in patch) contact.knownObjections = sanitizeMultilineText(patch.knownObjections, MAX_LONG_TEXT)
  if ('currentTooling' in patch) contact.currentTooling = sanitizeMultilineText(patch.currentTooling, MAX_LONG_TEXT)
  if ('lastContactDate' in patch) contact.lastContactDate = sanitizeDateOnly(patch.lastContactDate)
  if ('preferredLanguage' in patch) contact.preferredLanguage = sanitizeOptionalText(patch.preferredLanguage, MAX_SHORT_TEXT)
  if ('communicationStyle' in patch) contact.communicationStyle = sanitizeOptionalText(patch.communicationStyle, MAX_SHORT_TEXT)
  if ('timezone' in patch) contact.timezone = sanitizeOptionalText(patch.timezone, MAX_SHORT_TEXT)
  if ('personalNotes' in patch) contact.personalNotes = sanitizeMultilineText(patch.personalNotes, MAX_LONG_TEXT)
  if ('briefingNotes' in patch) contact.briefingNotes = sanitizeMultilineText(patch.briefingNotes, MAX_BRIEFING)

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

// --- Lookups for M19 Task 2's speaker-identification cascade ----------------
// Both are plain linear scans over listContacts() — fine at the scale this
// app operates at (a rep's own contacts, not a shared database), and it keeps
// the lookup honest about reading the SAME sanitized/normalized records every
// other consumer sees, rather than a separate index that could drift stale.

/** Find a contact by email, case-insensitively (both sides normalized the
 *  same way sanitizeEmail does). Returns null if no contact has this email,
 *  or if the input itself isn't a well-formed address. */
export async function findContactByEmail(dir: string, email: string): Promise<Contact | null> {
  const normalized = sanitizeEmail(email)
  if (!normalized) return null
  const contacts = await listContacts(dir)
  return contacts.find((c) => c.email === normalized) ?? null
}

/** Find a contact by E.164 phone number (exact match — the caller is
 *  responsible for having already normalized the number it's matching
 *  against, e.g. via the renderer's countryDial() + digit-stripping). */
export async function findContactByPhone(dir: string, phoneE164: string): Promise<Contact | null> {
  const normalized = sanitizePhoneE164(phoneE164)
  if (!normalized) return null
  const contacts = await listContacts(dir)
  return contacts.find((c) => c.phoneE164 === normalized) ?? null
}

/** Find a contact by exact name, case/whitespace-insensitive. Used by
 *  Contact Intelligence's full-auto attach path (contact-intelligence-ipc.ts)
 *  to avoid creating a duplicate contact when the detected name already
 *  matches an existing one — a plain exact match, not fuzzy, since a wrong
 *  auto-attach to the wrong person is worse than occasionally creating a
 *  near-duplicate the rep can merge later. */
export async function findContactByName(dir: string, name: string): Promise<Contact | null> {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized) return null
  const contacts = await listContacts(dir)
  return contacts.find((c) => c.name.trim().toLowerCase().replace(/\s+/g, ' ') === normalized) ?? null
}
