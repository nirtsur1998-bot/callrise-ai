import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContact } from '../contacts-fs'
import { parseDealValue, applyKycField } from '../kyc-apply'

describe('parseDealValue', () => {
  it('parses plain numbers', () => {
    expect(parseDealValue('50000')).toBe(50000)
    expect(parseDealValue('1200.50')).toBe(1200.5)
  })

  it('parses k/m suffixes', () => {
    expect(parseDealValue('50k')).toBe(50_000)
    expect(parseDealValue('1.2m')).toBe(1_200_000)
  })

  it('strips commas', () => {
    expect(parseDealValue('1,200,000')).toBe(1_200_000)
  })

  it('extracts the number out of surrounding prose', () => {
    expect(parseDealValue('around 75000 or so')).toBe(75000)
  })

  it('rejects text with no number at all', () => {
    expect(parseDealValue('maybe a lot')).toBeNull()
  })

  // Regression coverage for a review finding: taking the FIRST number in
  // AI-authored prose picked up decoy numbers (a quarter, a headcount) that
  // precede the real figure, silently saving the wrong value with no error.
  it('picks the largest number, not the first, when the text has a decoy number before the real one', () => {
    expect(parseDealValue('Q3 budget guidance is $50k')).toBe(50_000)
    expect(parseDealValue('closing by Q3, budget confirmed at $75,000')).toBe(75_000)
    expect(parseDealValue('2 decision makers, deal size around $120k')).toBe(120_000)
  })
})

describe('applyKycField', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-contacts-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function makeContact(): Promise<string> {
    const contact = await createContact(dir, { name: 'Dana Cohen' })
    if (!contact) throw new Error('setup failed')
    return contact.id
  }

  it('writes an allowed text field', async () => {
    const id = await makeContact()
    const updated = await applyKycField(dir, id, 'industry', 'Fintech')
    expect(updated?.industry).toBe('Fintech')
  })

  it('rejects a field not in KYC_UPDATABLE_FIELDS — identity fields never change this way', async () => {
    const id = await makeContact()
    const updated = await applyKycField(dir, id, 'email', 'new@example.com')
    expect(updated).toBeNull()
  })

  it('rejects an arbitrary unknown field name', async () => {
    const id = await makeContact()
    const updated = await applyKycField(dir, id, 'notAContactField', 'whatever')
    expect(updated).toBeNull()
  })

  it('parses and stores dealValue as a number', async () => {
    const id = await makeContact()
    const updated = await applyKycField(dir, id, 'dealValue', '$50k budget')
    expect(updated?.dealValue).toBe(50_000)
  })

  it('rejects an unparseable dealValue rather than silently clearing or zeroing it', async () => {
    const id = await makeContact()
    await applyKycField(dir, id, 'dealValue', '$50k budget') // establish a known-good value first
    const rejected = await applyKycField(dir, id, 'dealValue', 'a substantial amount')
    expect(rejected).toBeNull()
  })

  it('returns null for a nonexistent contact', async () => {
    const updated = await applyKycField(dir, 'not-a-real-id', 'industry', 'Fintech')
    expect(updated).toBeNull()
  })
})
