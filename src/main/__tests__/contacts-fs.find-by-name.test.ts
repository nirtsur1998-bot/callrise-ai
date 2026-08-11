import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContact, findContactByName } from '../contacts-fs'

// findContactByName backs Contact Intelligence's full-auto attach path
// (contact-intelligence-ipc.ts's maybeAutoCreateContact) — its whole job is
// to stop a repeat detection of the same buyer (no email, name-only signal)
// from silently minting a second, duplicate contact record.
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-contacts-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('findContactByName', () => {
  it('finds an exact match', async () => {
    const created = await createContact(dir, { name: 'Sarah Chen' })
    expect(created).not.toBeNull()
    const found = await findContactByName(dir, 'Sarah Chen')
    expect(found?.id).toBe(created!.id)
  })

  it('matches case-insensitively and tolerates extra whitespace', async () => {
    const created = await createContact(dir, { name: 'Sarah Chen' })
    expect(created).not.toBeNull()
    const found = await findContactByName(dir, '  sarah   chen  ')
    expect(found?.id).toBe(created!.id)
  })

  it('returns null when no contact has that name', async () => {
    await createContact(dir, { name: 'Sarah Chen' })
    expect(await findContactByName(dir, 'Priya Patel')).toBeNull()
  })

  it('returns null for an empty name', async () => {
    await createContact(dir, { name: 'Sarah Chen' })
    expect(await findContactByName(dir, '   ')).toBeNull()
  })
})
