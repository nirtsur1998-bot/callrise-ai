// BUG-095 — founder-reported, 2026-08-24: "you write a comment on a CRM client,
// you save it, come back and it disappeared. Same for drafting a note."
//
// ROOT CAUSE: `sanitizeContactRecord` rebuilds the contact as a CLOSED OBJECT
// LITERAL, field by field, and `comments` was never added to that list when the
// comments feature landed. Every read therefore strips them. Two consequences,
// the second worse than the first:
//
//   1. The comment is written to disk but invisible on every subsequent read.
//   2. `updateContact` is read-then-write, and the read already dropped them —
//      so the next unrelated edit to the contact ERASES the comments from disk
//      permanently.
//
// These tests drive the real filesystem functions, no mocks, and each asserts
// the round trip rather than the return value of the call that wrote it (the
// returned object was always correct — that is precisely why this shipped).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addComment,
  createContact,
  getContact,
  listContacts,
  importContact,
  removeComment,
  updateContact,
  type Contact
} from '../contacts-fs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contacts-comments-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function newContact(): Promise<string> {
  const c = await createContact(dir, { name: 'Dana Levi', company: 'Acme' })
  expect(c).not.toBeNull()
  return c!.id
}

describe('BUG-095 — a posted comment must survive a round trip to disk', () => {
  it('the comment is still there when the contact is read again', async () => {
    const id = await newContact()
    const afterPost = await addComment(dir, id, 'Wants pricing by Friday')
    // Control: the call that wrote it reports success and shows the comment.
    // This half always passed — it is what made the bug invisible.
    expect(afterPost?.comments?.map((c) => c.text)).toEqual(['Wants pricing by Friday'])

    // The half that matters: read it back the way reopening the page does.
    const reread = await getContact(dir, id)
    expect(reread?.comments?.map((c) => c.text)).toEqual(['Wants pricing by Friday'])
  })

  it('comments survive in the LIST view too, not just the detail read', async () => {
    const id = await newContact()
    await addComment(dir, id, 'Left a voicemail')
    const all = await listContacts(dir)
    const found = all.find((c) => c.id === id)
    expect(found?.comments?.map((c) => c.text)).toEqual(['Left a voicemail'])
  })

  it('an AI-drafted note survives the same round trip (the founder’s second symptom)', async () => {
    const id = await newContact()
    await addComment(dir, id, 'Summary: budget confirmed, next step demo.', 'ai')
    const reread = await getContact(dir, id)
    expect(reread?.comments).toHaveLength(1)
    expect(reread?.comments?.[0].source).toBe('ai')
  })

  it('multiple comments accumulate instead of each one replacing the last', async () => {
    const id = await newContact()
    await addComment(dir, id, 'first')
    await addComment(dir, id, 'second')
    const reread = await getContact(dir, id)
    expect(reread?.comments?.map((c) => c.text)).toEqual(['first', 'second'])
  })

  it('THE DESTRUCTIVE HALF: an unrelated edit must not erase existing comments', async () => {
    const id = await newContact()
    await addComment(dir, id, 'Do not lose me')

    // The rep edits any other field — phone, pipeline stage, anything.
    await updateContact(dir, id, { phone: '050-1234567' })

    const reread = await getContact(dir, id)
    expect(reread?.phone).toBe('050-1234567') // the edit landed
    expect(reread?.comments?.map((c) => c.text)).toEqual(['Do not lose me']) // and so did the comment
  })

  it('deleting one comment leaves the others intact across a round trip', async () => {
    const id = await newContact()
    const a = await addComment(dir, id, 'keep me')
    await addComment(dir, id, 'delete me')
    const target = (await getContact(dir, id))?.comments?.find((c) => c.text === 'delete me')
    expect(target).toBeDefined()
    await removeComment(dir, id, target!.id)
    const reread = await getContact(dir, id)
    expect(reread?.comments?.map((c) => c.text)).toEqual(['keep me'])
    expect(a).not.toBeNull()
  })
})

describe('BUG-095 — the cloud round trip carries comments too', () => {
  // Both the backup push (`payload: c` from listContacts) and the restore
  // (`importContact` -> sanitizeContactRecord) funnel through the SAME
  // sanitizer that dropped them. So before the fix, comments were lost in
  // three places at once: local reads, the upload, and the restore. One fix
  // repairs all three — but the cloud half deserves its own assertion, since
  // losing it there means losing it on a new machine forever.
  it('a contact restored from a cloud payload keeps its comments', async () => {
    const id = await newContact()
    await addComment(dir, id, 'Said yes to the pilot')
    const asCloudPayload = (await getContact(dir, id))!

    // A fresh machine: different directory, restoring from the payload the
    // backup would have uploaded.
    const other = mkdtempSync(join(tmpdir(), 'contacts-restore-'))
    try {
      const restored = await importContact(other, JSON.parse(JSON.stringify(asCloudPayload)))
      expect(restored?.comments?.map((c) => c.text)).toEqual(['Said yes to the pilot'])
      const reread = await getContact(other, id)
      expect(reread?.comments?.map((c) => c.text)).toEqual(['Said yes to the pilot'])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('a malformed comment from disk or cloud is dropped, not trusted through', async () => {
    const id = await newContact()
    await addComment(dir, id, 'good one')
    const payload = { ...(await getContact(dir, id))!, comments: [
      { id: 'not a safe id!!', text: 'forged', createdAt: 'x', source: 'ai' },
      { id: '11111111-1111-4111-8111-111111111111', text: '', createdAt: 'x', source: 'user' },
      'not even an object'
    ] } as unknown
    const other = mkdtempSync(join(tmpdir(), 'contacts-bad-'))
    try {
      const restored = await importContact(other, JSON.parse(JSON.stringify(payload)))
      // Every entry above is malformed; none may survive.
      expect(restored?.comments).toBeUndefined()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('THE STRUCTURAL GUARD — no Contact field may be silently dropped again', () => {
  // BUG-095's real lesson is not "comments was missing" — it is that
  // sanitizeContactRecord rebuilds Contact as a CLOSED OBJECT LITERAL, so any
  // field added later is dropped by default and nothing complains. Comments
  // sat in that hole from the day the feature shipped.
  //
  // This fixture is typed `Required<Contact>`, which means TypeScript REFUSES
  // TO COMPILE this file the moment a new field is added to Contact until the
  // fixture sets it. The round-trip assertion then proves the sanitizer keeps
  // it. Compile-time completeness + runtime preservation: the same
  // "derive, don't hand-maintain" principle as the telemetry file list and the
  // renderer's syncScope union.
  const FULL: Required<Contact> = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Dana Levi',
    company: 'Acme',
    cid: 'C-1001',
    registeredAt: '2026-01-15',
    country: 'IL',
    email: 'dana@example.com',
    phoneCountry: 'IL',
    phone: '050-1234567',
    phoneE164: '+972501234567',
    notes: 'top of funnel',
    industry: 'fintech',
    companySize: '50-200',
    website: 'https://acme.example',
    registrationNumber: '514000000',
    verificationStatus: 'verified',
    title: 'VP Sales',
    decisionAuthority: 'economic buyer',
    otherStakeholders: 'CFO',
    dealValue: 42000,
    pipelineStage: 'demo',
    leadSource: 'referral',
    budgetIndication: 'approved',
    timeline: 'Q3',
    competitors: 'Gong',
    knownObjections: 'price',
    currentTooling: 'spreadsheets',
    lastContactDate: '2026-08-01',
    preferredLanguage: 'he',
    communicationStyle: 'direct',
    timezone: 'Asia/Jerusalem',
    personalNotes: 'two kids, cycles',
    briefingNotes: 'lead with ROI',
    createdAt: '2026-01-15T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    deleted: false,
    comments: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        text: 'Wants pricing by Friday',
        createdAt: '2026-08-01T10:00:00.000Z',
        source: 'user'
      }
    ]
  }

  it('every field of a fully-populated Contact survives write -> read', async () => {
    // importContact is the write path that takes a whole record (the same one
    // the cloud restore uses), so it exercises the sanitizer end to end.
    const saved = await importContact(dir, JSON.parse(JSON.stringify(FULL)))
    expect(saved).not.toBeNull()
    const reread = await getContact(dir, FULL.id)
    expect(reread).not.toBeNull()

    // Two fields have a DOCUMENTED normalisation rather than exact round trip.
    // They are asserted explicitly below instead of skipped, so that if either
    // normalisation ever changes the test says so.
    const NORMALISED = new Set<keyof Contact>(['updatedAt', 'deleted'])
    for (const key of Object.keys(FULL) as (keyof Contact)[]) {
      if (NORMALISED.has(key)) continue
      expect(reread?.[key], `field "${key}" did not survive the round trip`).toEqual(FULL[key])
    }
    // updatedAt is restamped by the writer (it is the backup ordering key).
    expect(typeof reread?.updatedAt).toBe('string')
    // deleted:false is stored as ABSENT — a live contact simply has no
    // tombstone flag, which is semantically identical. deleted:true takes a
    // different path entirely (a minimal tombstone), covered below.
    expect(reread?.deleted ?? false).toBe(false)
  })

  it('the tombstone path still collapses a deleted contact to a minimal record', async () => {
    await importContact(dir, { ...JSON.parse(JSON.stringify(FULL)), deleted: true })
    // getContact treats a tombstone as gone...
    expect(await getContact(dir, FULL.id)).toBeNull()
    // ...but it is retained on disk so the deletion can propagate to other devices.
    const withDeleted = await listContacts(dir, { includeDeleted: true })
    const tomb = withDeleted.find((c) => c.id === FULL.id)
    expect(tomb?.deleted).toBe(true)
    expect(tomb?.comments).toBeUndefined() // a tombstone carries no content
  })
})
