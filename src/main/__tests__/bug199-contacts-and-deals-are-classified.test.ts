// BUG-199 — the compile-time egress guard covered CALLS only.
//
// `CALL_FIELD_RULES` makes an unclassified field on a call record a compile
// error rather than a silent leak; it exists because an allowlist fell behind
// a growing type three separate times (BUG-014, BUG-028, BUG-115). Contacts
// and deals had no equivalent, and `backup.ts` pushed `payload: c` — the whole
// record — so any field added to either reached the user's cloud backup on the
// next sync with nothing having classified it.
//
// THE CLAIM THIS FILE HAS TO PROVE IS "NOTHING CHANGED". Every field on both
// records is user-entered CRM data the backup exists to carry, so the fix is a
// missing guard being added, not an escaping field being caught. The first two
// tests are therefore the load-bearing ones: the derived payload must be
// byte-identical to the spread it replaces, on a record with every field set.
//
// The third test is the one that stops this being a guard that cannot fire.
// With everything classified SYNCED, the builder has never actually excluded
// anything — so it is exercised directly with a LOCAL_ONLY field. A filter
// that has only ever been asked to pass things is not known to filter.
import { describe, expect, it } from 'vitest'
import { CONTACT_FIELD_RULES, contactBackupPayload, type Contact } from '../contacts-fs'
import { DEAL_FIELD_RULES, dealBackupPayload, type Deal } from '../deals-fs'
import { buildEgressPayload, type FieldEgress } from '../record-egress'

/** Every field on a Contact set to something distinguishable. Built by hand
 *  ON PURPOSE: if a field is added to the type and not to this fixture, the
 *  round-trip test below stops covering it, and the compiler says so. */
const FULL_CONTACT: Required<Contact> = {
  id: 'c-1',
  name: 'Dana Reyes',
  company: 'Northwind',
  cid: 'ACC-4471',
  registeredAt: '2025-04-02',
  country: 'US',
  email: 'dana@example.com',
  phoneCountry: 'US',
  phone: '4155551234',
  phoneE164: '+14155551234',
  notes: 'prefers email',
  industry: 'logistics',
  companySize: '51-250',
  website: 'https://example.com',
  registrationNumber: 'VAT-99',
  verificationStatus: 'verified',
  title: 'VP Ops',
  decisionAuthority: 'economic buyer',
  otherStakeholders: 'Sam in finance',
  dealValue: 42000,
  pipelineStage: 'evaluation',
  leadSource: 'referral',
  budgetIndication: 'approved',
  timeline: 'Q1',
  competitors: 'Acme',
  knownObjections: 'price',
  currentTooling: 'spreadsheets',
  lastContactDate: '2026-09-01',
  preferredLanguage: 'en',
  communicationStyle: 'email-first',
  timezone: 'America/New_York',
  personalNotes: 'two kids, cycles',
  briefingNotes: 'wants a phased rollout',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
  deleted: false,
  comments: [{ id: 'cm-1', text: 'left a voicemail', createdAt: '2026-09-01T00:00:00.000Z', source: 'user' }]
}

const FULL_DEAL: Required<Deal> = {
  id: 'd-1',
  title: 'Northwind renewal',
  contactId: 'c-1',
  stageId: 'stage-2',
  value: 42000,
  expectedCloseDate: '2026-12-01',
  notes: 'two-year term',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
  riskAssessment: undefined as never,
  riskAssessmentHistory: [],
  deleted: false,
  stageHistory: [{ stageId: 'stage-1', changedAt: '2026-02-01T00:00:00.000Z' }],
  outcomeReason: 'budget moved to next year',
  origin: 'backfill'
}

describe('BUG-199 — the guard changes nothing that leaves the device today', () => {
  it('a contact payload equals the whole-record spread it replaces', () => {
    // The exact expression backup.ts used before: `payload: c`.
    expect(contactBackupPayload(FULL_CONTACT)).toEqual({ ...FULL_CONTACT })
  })

  it('a deal payload equals the spread it replaces, outcomeReason included', () => {
    // The exact expression backup.ts used before.
    expect(dealBackupPayload(FULL_DEAL)).toEqual({
      ...FULL_DEAL,
      outcomeReason: FULL_DEAL.outcomeReason ?? null
    })
  })

  it("keeps outcomeReason's three-way contract: ABSENT becomes explicit null", () => {
    // null clears on import, ABSENT preserves. A bare derivation would drop the
    // key (it drops undefined to match what the record holds), which would turn
    // "cleared here" into "this build never heard of the field".
    const { outcomeReason: _dropped, ...withoutReason } = FULL_DEAL
    const payload = dealBackupPayload(withoutReason as Deal)
    expect('outcomeReason' in payload).toBe(true)
    expect(payload.outcomeReason).toBeNull()
  })

  it('drops absent optional fields rather than sending explicit undefined', () => {
    const sparse: Contact = {
      id: 'c-2',
      name: 'Min',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const payload = contactBackupPayload(sparse)
    expect(payload).toEqual({ ...sparse })
    expect('personalNotes' in payload).toBe(false)
  })
})

describe('BUG-199 — the guard CAN refuse, not just pass', () => {
  it('excludes a LOCAL_ONLY field', () => {
    // Everything on both real records is SYNCED, so nothing in production
    // exercises the exclusion path. Without this, the builder would be a filter
    // that has only ever been asked to pass things — indistinguishable from a
    // spread, and it would stay that way until the first field someone wanted
    // to keep local, which is the worst moment to discover it.
    type Row = { keep: string; secret: string }
    const rules: { [K in keyof Required<Row>]: FieldEgress } = {
      keep: 'SYNCED',
      secret: 'LOCAL_ONLY'
    }
    expect(buildEgressPayload({ keep: 'a', secret: 'b' }, rules)).toEqual({ keep: 'a' })
  })

  it('classifies every field of both records, with no field left unlisted', () => {
    // The compile-time guard is the real one — `{ [K in keyof Required<T>] }`
    // makes a missing field TS2741, verified by deleting one and watching it
    // fail. This runtime assertion catches the other direction: a key in the
    // table that is no longer on the type, which TypeScript permits silently
    // once the field is gone.
    for (const key of Object.keys(CONTACT_FIELD_RULES)) {
      expect(Object.prototype.hasOwnProperty.call(FULL_CONTACT, key), `${key} is in CONTACT_FIELD_RULES but not on Contact`).toBe(true)
    }
    for (const key of Object.keys(DEAL_FIELD_RULES)) {
      expect(Object.prototype.hasOwnProperty.call(FULL_DEAL, key), `${key} is in DEAL_FIELD_RULES but not on Deal`).toBe(true)
    }
  })
})
