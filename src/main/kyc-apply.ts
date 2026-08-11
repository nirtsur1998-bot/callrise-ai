// The shared "apply one AI-suggested KYC fact to a contact" logic — used by
// both Workstream B's coaching-chat suggestion chips and Workstream C's
// standalone KYC-harvest chips, so the validation rules (allowed fields,
// numeric parsing for dealValue) live in exactly one place instead of two
// copies that could quietly drift apart.
import { KYC_UPDATABLE_FIELDS } from './coaching-chat'
import { updateContact, type Contact } from './contacts-fs'

/** Parses free text like "$50k", "1,200,000", "around 75000" into a plain
 *  number, or null if nothing numeric could be pulled out — the caller must
 *  treat null as a rejection, not silently save 0 or drop the field.
 *
 *  Picks the LARGEST number found, not the first — the AI-authored fact text
 *  is prose, not a bare figure ("Q3 budget guidance is $50k", "2 decision
 *  makers, deal size around $120k"), and an earlier decoy number (a quarter,
 *  a headcount) is always smaller than an actual deal value in practice.
 *  Taking the first match alone silently saved the WRONG number for exactly
 *  those cases (e.g. "3" from "Q3" instead of "50000" from "$50k"). */
export function parseDealValue(text: string): number | null {
  const cleaned = text.replace(/,/g, '')
  const matches = [...cleaned.matchAll(/(\d+(?:\.\d+)?)\s*(k|m)?/gi)]
  let best: number | null = null
  for (const match of matches) {
    const n = Number(match[1])
    if (!Number.isFinite(n)) continue
    const suffix = match[2]?.toLowerCase()
    const value = suffix === 'k' ? n * 1_000 : suffix === 'm' ? n * 1_000_000 : n
    if (best === null || value > best) best = value
  }
  return best
}

/** Validates `field` against KYC_UPDATABLE_FIELDS, parses/rejects a numeric
 *  dealValue, then writes the single field via updateContact(). Returns null
 *  on any rejection (unknown field, unparseable dealValue, contact not
 *  found) — never partially applies. */
export async function applyKycField(
  dir: string,
  contactId: string,
  field: string,
  text: string
): Promise<Contact | null> {
  if (!(KYC_UPDATABLE_FIELDS as readonly string[]).includes(field)) return null
  let value: string | number = text
  if (field === 'dealValue') {
    // The one numeric KYC field — contacts-fs.ts's own sanitizeValue()
    // silently drops non-numeric input rather than erroring, which would
    // make an unparseable suggestion (e.g. "around 50k maybe") look
    // accepted in the UI while actually saving nothing. Reject it here
    // instead so the caller gets a real failure signal.
    const parsed = parseDealValue(text)
    if (parsed === null) return null
    value = parsed
  }
  return updateContact(dir, contactId, { [field]: value } as Partial<Contact>)
}
