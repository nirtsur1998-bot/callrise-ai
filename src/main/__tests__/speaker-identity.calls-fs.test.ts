import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCall, getCall, setSpeakerIdentity, speakerIdentityKey } from '../calls-fs'

describe('speakerIdentityKey', () => {
  it('keys multichannel by channel, not just speaker', () => {
    expect(speakerIdentityKey({ speaker: 0, channel: 0 })).toBe('ch0/spk0')
    expect(speakerIdentityKey({ speaker: 1, channel: 1 })).toBe('ch1/spk1')
  })

  it('keys mono/diarized calls without a channel prefix', () => {
    expect(speakerIdentityKey({ speaker: 0 })).toBe('mono/spk0')
    expect(speakerIdentityKey({ speaker: 2 })).toBe('mono/spk2')
  })

  it('never collides a channel-0 speaker with a mono speaker of the same number', () => {
    // The exact bug this key format exists to prevent — see the M19 brief:
    // "identity key is (channel_index, speaker) — always."
    expect(speakerIdentityKey({ speaker: 0, channel: 0 })).not.toBe(speakerIdentityKey({ speaker: 0 }))
  })
})

describe('setSpeakerIdentity', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-calls-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function makeCall(): Promise<string> {
    const summary = await saveCall(dir, {
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      segments: [
        { speaker: 0, channel: 0, text: 'Hi, this is Alex from Acme.' },
        { speaker: 1, channel: 1, text: 'Hi Alex, thanks for calling.' }
      ],
      // Consented, recordOtherParty: true — these tests target ch1/spk1 (the
      // buyer channel), and applyConsentRetention (M11, extended M19 Task 2)
      // correctly strips a buyer-channel identity on every read when consent
      // isn't held. Without this, every ch1/spk1 assertion here would be
      // fighting that invariant instead of testing setSpeakerIdentity itself.
      consent: { status: 'consented', jurisdiction: 'two-party', recordOtherParty: true }
    })
    return summary.id
  }

  it('sets a name for a speaker key', async () => {
    const callId = await makeCall()
    const updated = await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
      name: 'Sarah Chen',
      source: 'calendar',
      confidence: 'high'
    })
    expect(updated?.speakerIdentities?.['ch1/spk1']).toMatchObject({
      name: 'Sarah Chen',
      source: 'calendar',
      confidence: 'high'
    })
  })

  it('retroactively renames — reading the call back reflects the new name', async () => {
    const callId = await makeCall()
    await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
      name: 'Sarah Chen',
      source: 'calendar',
      confidence: 'high'
    })
    const reread = await getCall(dir, callId)
    expect(reread?.speakerIdentities?.['ch1/spk1']?.name).toBe('Sarah Chen')
  })

  it('a manual rename overwrites a prior auto-resolved entry', async () => {
    const callId = await makeCall()
    await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
      name: 'S. Chen',
      source: 'self-intro',
      confidence: 'low'
    })
    const renamed = await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
      name: 'Sarah Chen',
      source: 'manual',
      confidence: 'high'
    })
    expect(renamed?.speakerIdentities?.['ch1/spk1']).toMatchObject({
      name: 'Sarah Chen',
      source: 'manual'
    })
  })

  it('clears an identity when name is null', async () => {
    const callId = await makeCall()
    await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
      name: 'Sarah Chen',
      source: 'manual',
      confidence: 'high'
    })
    const cleared = await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
      name: null,
      source: 'manual',
      confidence: 'high'
    })
    expect(cleared?.speakerIdentities?.['ch1/spk1']).toBeUndefined()
  })

  it('rejects a malformed key rather than writing garbage', async () => {
    const callId = await makeCall()
    const result = await setSpeakerIdentity(dir, callId, 'not-a-real-key', {
      name: 'Whoever',
      source: 'manual',
      confidence: 'high'
    })
    expect(result).toBeNull()
  })

  it('falls back to source "manual" and confidence "high" for an unrecognized value', async () => {
    const callId = await makeCall()
    const result = await setSpeakerIdentity(dir, callId, 'ch0/spk0', {
      name: 'Me',
      source: 'not-a-real-source',
      confidence: 'not-a-real-confidence'
    })
    expect(result?.speakerIdentities?.['ch0/spk0']).toMatchObject({
      source: 'manual',
      confidence: 'high'
    })
  })

  it('does not overwrite existing identities for OTHER speaker keys', async () => {
    const callId = await makeCall()
    await setSpeakerIdentity(dir, callId, 'ch0/spk0', {
      name: 'Me',
      source: 'user-profile',
      confidence: 'high'
    })
    const updated = await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
      name: 'Sarah Chen',
      source: 'calendar',
      confidence: 'high'
    })
    expect(updated?.speakerIdentities?.['ch0/spk0']?.name).toBe('Me')
    expect(updated?.speakerIdentities?.['ch1/spk1']?.name).toBe('Sarah Chen')
  })

  it('returns null for a nonexistent call', async () => {
    const result = await setSpeakerIdentity(dir, 'does-not-exist', 'ch0/spk0', {
      name: 'Whoever',
      source: 'manual',
      confidence: 'high'
    })
    expect(result).toBeNull()
  })
})
