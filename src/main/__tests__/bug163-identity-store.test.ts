// BUG-163, storage half — the write choke point and the read-time drop.
//
// The renderer bug was cosmetic ("Detected null on this call"); the button
// beside it was not — "Create contact for null" would have put a contact
// literally named null into the rep's CRM. Both halves are tested here
// against the real calls-fs, on a temp dir.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCall, setSpeakerIdentity, saveCall } from '../calls-fs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bug163-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function makeCall(): Promise<string> {
  const call = await saveCall(dir, {
    segments: [
      { speaker: 0, channel: 0, text: 'Thanks for the time today.', startMs: 0 },
      { speaker: 1, channel: 1, text: 'Your price is higher than Gong.', startMs: 4000 }
    ],
    // `recordOtherParty` is COMPUTED from status (sanitizeConsent), never
    // trusted from input — without 'consented' here the consent-retention
    // strip removes the other party's identity on read, and every assertion
    // in this file about ch1/spk1 would pass for the wrong reason.
    consent: { status: 'consented', recordOtherParty: true }
  } as never)
  return call.id
}

describe('BUG-163 — the write choke point', () => {
  it('refuses a model-sourced name that is really a non-answer', async () => {
    const id = await makeCall()
    await setSpeakerIdentity(dir, id, 'ch1/spk1', {
      name: 'null',
      source: 'self-intro',
      confidence: 'medium'
    })
    const after = await getCall(dir, id)
    expect(after?.speakerIdentities?.['ch1/spk1']).toBeUndefined()
  })

  it('CONTROL — still writes a real name from the same source', async () => {
    const id = await makeCall()
    await setSpeakerIdentity(dir, id, 'ch1/spk1', {
      name: 'Sarah Chen',
      source: 'self-intro',
      confidence: 'medium'
    })
    const after = await getCall(dir, id)
    expect(after?.speakerIdentities?.['ch1/spk1']?.name).toBe('Sarah Chen')
  })

  it('does NOT argue with a name the rep typed themselves', async () => {
    const id = await makeCall()
    await setSpeakerIdentity(dir, id, 'ch1/spk1', {
      name: 'N/A',
      source: 'manual',
      confidence: 'high'
    })
    const after = await getCall(dir, id)
    expect(after?.speakerIdentities?.['ch1/spk1']?.name).toBe('N/A')
  })

  it('leaves an existing good name alone when a placeholder arrives later', async () => {
    const id = await makeCall()
    await setSpeakerIdentity(dir, id, 'ch1/spk1', {
      name: 'Sarah Chen',
      source: 'self-intro',
      confidence: 'medium'
    })
    await setSpeakerIdentity(dir, id, 'ch1/spk1', {
      name: 'unknown',
      source: 'self-intro',
      confidence: 'medium'
    })
    const after = await getCall(dir, id)
    expect(after?.speakerIdentities?.['ch1/spk1']?.name).toBe('Sarah Chen')
  })
})

describe('BUG-163 — the read-time drop, for records already on disk', () => {
  // The EXACT record read off the founder's machine on 2026-09-02.
  const POISONED = {
    'ch1/spk1': {
      name: 'null',
      source: 'self-intro',
      confidence: 'medium',
      resolvedAt: '2026-09-01T21:50:25.701Z'
    },
    'ch0/spk0': {
      name: 'Thomas',
      source: 'user-profile',
      confidence: 'high',
      resolvedAt: '2026-09-01T21:51:15.799Z'
    }
  }

  it('drops the placeholder identity and keeps the real one', async () => {
    const id = await makeCall()
    // Write it the way the old build did — straight into the file, bypassing
    // the (now guarded) setter, which is exactly how these records exist.
    const file = join(dir, `${id}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.speakerIdentities = POISONED
    writeFileSync(file, JSON.stringify(raw))

    const after = await getCall(dir, id)
    expect(after?.speakerIdentities?.['ch1/spk1']).toBeUndefined()
    // CONTROL — the drop is targeted, not a wipe of the whole map.
    expect(after?.speakerIdentities?.['ch0/spk0']?.name).toBe('Thomas')
  })

  it('does not rewrite the file — the drop is read-only', async () => {
    const id = await makeCall()
    const file = join(dir, `${id}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.speakerIdentities = POISONED
    writeFileSync(file, JSON.stringify(raw))
    const before = readFileSync(file, 'utf8')

    await getCall(dir, id)

    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
