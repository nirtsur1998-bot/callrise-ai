import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  // The TOCTOU-race fix (commit 2cdce4d): the manual-rename guard is checked
  // atomically inside setSpeakerIdentity's own lock, not from a pre-read
  // snapshot — resolve-for-call.ts is the only caller, and had no test
  // coverage for this option anywhere in the suite before this.
  describe('skipIfManual', () => {
    it('is a no-op against an existing manual entry', async () => {
      const callId = await makeCall()
      await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
        name: 'Sarah Chen',
        source: 'manual',
        confidence: 'high'
      })
      const result = await setSpeakerIdentity(
        dir,
        callId,
        'ch1/spk1',
        { name: 'Auto-Resolved Name', source: 'calendar', confidence: 'high' },
        { skipIfManual: true }
      )
      // Returns the call UNCHANGED (not null — the call exists, the write was
      // just skipped), and the manual entry survives untouched.
      expect(result?.speakerIdentities?.['ch1/spk1']).toMatchObject({
        name: 'Sarah Chen',
        source: 'manual'
      })
    })

    it('writes normally when the existing entry is not manual', async () => {
      const callId = await makeCall()
      await setSpeakerIdentity(dir, callId, 'ch1/spk1', {
        name: 'S. Chen',
        source: 'self-intro',
        confidence: 'low'
      })
      const result = await setSpeakerIdentity(
        dir,
        callId,
        'ch1/spk1',
        { name: 'Sarah Chen', source: 'calendar', confidence: 'high' },
        { skipIfManual: true }
      )
      expect(result?.speakerIdentities?.['ch1/spk1']).toMatchObject({
        name: 'Sarah Chen',
        source: 'calendar'
      })
    })

    it('writes normally when there is no existing entry at all', async () => {
      const callId = await makeCall()
      const result = await setSpeakerIdentity(
        dir,
        callId,
        'ch1/spk1',
        { name: 'Sarah Chen', source: 'calendar', confidence: 'high' },
        { skipIfManual: true }
      )
      expect(result?.speakerIdentities?.['ch1/spk1']?.name).toBe('Sarah Chen')
    })
  })
})

// applyConsentRetention isn't exported directly (it's an internal guard run
// by saveCall/getCall/listCalls/importCall) — exercised here via a raw
// on-disk Call file + getCall(), which is exactly the shape a real
// hand-edited-or-legacy file takes. Covers the mono-vs-multichannel fix:
// BUYER_SPEAKER=1 is only a fixed fact for multichannel; for mono calls the
// buyer's actual speaker number depends on the (possibly still-unknown)
// AI-determined repSpeaker.
describe('applyConsentRetention (via getCall)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-retention-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  interface RawCallOpts {
    id: string
    segments: { speaker: number; channel?: number; text: string }[]
    speakerIdentities: Record<string, { name: string; source: string; confidence: string; resolvedAt: string }>
    repSpeaker?: number | null
    recordOtherParty?: boolean
    bookmarks?: { id: string; atMs: number; text: string; createdAt: string }[]
  }

  async function writeRawCall(opts: RawCallOpts): Promise<void> {
    const call = {
      id: opts.id,
      title: 'Test call',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: 60_000,
      speakerCount: 2,
      preview: '',
      segments: opts.segments,
      attachments: [],
      consent: {
        status: opts.recordOtherParty ? 'consented' : 'not-asked',
        jurisdiction: 'two-party',
        recordOtherParty: opts.recordOtherParty === true
      },
      speakerIdentities: opts.speakerIdentities,
      ...(opts.bookmarks ? { bookmarks: opts.bookmarks } : {}),
      ...(opts.repSpeaker !== undefined
        ? { coaching: { metrics: { repSpeaker: opts.repSpeaker } } }
        : {})
    }
    await writeFile(join(dir, `${opts.id}.json`), JSON.stringify(call), 'utf8')
  }

  const identity = (
    name: string
  ): { name: string; source: string; confidence: 'high'; resolvedAt: string } => ({
    name,
    source: 'calendar',
    confidence: 'high' as const,
    resolvedAt: new Date().toISOString()
  })

  it('multichannel: strips only ch1 (structurally fixed) without consent', async () => {
    await writeRawCall({
      id: 'mc-no-consent',
      segments: [
        { speaker: 0, channel: 0, text: 'rep line' },
        { speaker: 1, channel: 1, text: 'buyer line' }
      ],
      speakerIdentities: { 'ch0/spk0': identity('Me'), 'ch1/spk1': identity('Sarah Chen') },
      recordOtherParty: false
    })
    const call = await getCall(dir, 'mc-no-consent')
    expect(call?.speakerIdentities?.['ch0/spk0']?.name).toBe('Me')
    expect(call?.speakerIdentities?.['ch1/spk1']).toBeUndefined()
    expect(call?.segments.map((s) => s.speaker)).toEqual([0])
  })

  // Mono retention policy, decided during the M20 merge (2026-08-04): a mono
  // call is NEVER stripped, regardless of repSpeaker. `speaker` under
  // diarization is a GUESS, not a hardware fact — a transcriber mishearing a
  // pause or pitch change as a second voice happens on ordinary single-person
  // calls, not only on calls with a real second party. Treating "not provably
  // the rep" as reason to strip (this file's previous behavior, tested below
  // as three separate scenarios) reliably destroyed the rep's own words
  // whenever that happened, on calls with no real "other party" to protect in
  // the first place — see calls-fs.ts's isOtherPartySpeaker doc comment for
  // the full reasoning. Multichannel is unaffected: channel is a hardware
  // fact, so it remains the only signal this strip trusts (see the test
  // above).
  it('mono: nothing is stripped even when repSpeaker is known — the number is a guess, not a channel', async () => {
    await writeRawCall({
      id: 'mono-rep1',
      segments: [
        { speaker: 0, text: 'buyer line' },
        { speaker: 1, text: 'rep line' }
      ],
      speakerIdentities: { 'mono/spk0': identity('Sarah Chen'), 'mono/spk1': identity('Me') },
      repSpeaker: 1,
      recordOtherParty: false
    })
    const call = await getCall(dir, 'mono-rep1')
    expect(call?.speakerIdentities?.['mono/spk1']?.name).toBe('Me')
    expect(call?.speakerIdentities?.['mono/spk0']?.name).toBe('Sarah Chen')
    expect(call?.segments.map((s) => s.speaker)).toEqual([0, 1])
  })

  it('mono: nothing is stripped with the other repSpeaker value either', async () => {
    await writeRawCall({
      id: 'mono-rep0',
      segments: [
        { speaker: 0, text: 'rep line' },
        { speaker: 1, text: 'buyer line' }
      ],
      speakerIdentities: { 'mono/spk0': identity('Me'), 'mono/spk1': identity('Sarah Chen') },
      repSpeaker: 0,
      recordOtherParty: false
    })
    const call = await getCall(dir, 'mono-rep0')
    expect(call?.speakerIdentities?.['mono/spk0']?.name).toBe('Me')
    expect(call?.speakerIdentities?.['mono/spk1']?.name).toBe('Sarah Chen')
    expect(call?.segments.map((s) => s.speaker)).toEqual([0, 1])
  })

  it('mono: nothing is stripped when repSpeaker is not yet known', async () => {
    await writeRawCall({
      id: 'mono-unknown-rep',
      segments: [
        { speaker: 0, text: 'presumed rep line' },
        { speaker: 1, text: 'presumed buyer line' }
      ],
      speakerIdentities: { 'mono/spk0': identity('Me'), 'mono/spk1': identity('Sarah Chen') },
      repSpeaker: null,
      recordOtherParty: false
    })
    const call = await getCall(dir, 'mono-unknown-rep')
    expect(call?.speakerIdentities?.['mono/spk0']?.name).toBe('Me')
    expect(call?.speakerIdentities?.['mono/spk1']?.name).toBe('Sarah Chen')
    expect(call?.segments.map((s) => s.speaker)).toEqual([0, 1])
  })

  it('mono: nothing is stripped once consent is actually held', async () => {
    await writeRawCall({
      id: 'mono-consented',
      segments: [
        { speaker: 0, text: 'buyer line' },
        { speaker: 1, text: 'rep line' }
      ],
      speakerIdentities: { 'mono/spk0': identity('Sarah Chen'), 'mono/spk1': identity('Me') },
      repSpeaker: 1,
      recordOtherParty: true
    })
    const call = await getCall(dir, 'mono-consented')
    expect(call?.speakerIdentities?.['mono/spk0']?.name).toBe('Sarah Chen')
    expect(call?.speakerIdentities?.['mono/spk1']?.name).toBe('Me')
    expect(call?.segments).toHaveLength(2)
  })

  it('mixed regime: each segment is judged by its OWN channel, not a call-wide flag', async () => {
    // The mid-call "enable buyer capture" switch: earlier segments are mono
    // (diarized guesses, never stripped), later segments are channel-tagged
    // (a hardware fact, stripped per the usual rule). An earlier design used
    // one per-call flag for this decision and applied the channel-based strip
    // to EVERY segment once buyer capture had run at all — including the
    // earlier mono-regime ones, which is exactly what this test guards
    // against regressing to.
    await writeRawCall({
      id: 'mixed-regime',
      segments: [
        { speaker: 1, text: 'mono guess before the switch' },
        { speaker: 0, channel: 0, text: 'rep after switching to buyer capture' },
        { speaker: 1, channel: 1, text: 'buyer after switching to buyer capture' }
      ],
      speakerIdentities: {},
      repSpeaker: 0,
      recordOtherParty: false
    })
    const call = await getCall(dir, 'mixed-regime')
    // The mono segment survives regardless of its speaker number; the
    // channel-1 segment is stripped as the real buyer channel.
    expect(call?.segments.map((s) => s.text)).toEqual([
      'mono guess before the switch',
      'rep after switching to buyer capture'
    ])
  })

  // M22 bug hunt: bookmarks ("clip this") are flattened, unattributed text —
  // the Bookmark shape carries no channel/speaker, so there is no surgical
  // strip available the way there is for segments. Before this fix,
  // applyConsentRetention stripped segments and speakerIdentities but left
  // call.bookmarks untouched, so a buyer's verbatim words clipped mid-call
  // survived a later consent revoke indefinitely (and could reach cloud
  // backup if transcript sync was on).
  it('strips bookmarks entirely when consent is not held — no per-word strip is possible', async () => {
    await writeRawCall({
      id: 'bookmarks-no-consent',
      segments: [{ speaker: 0, channel: 0, text: 'rep line' }],
      speakerIdentities: {},
      recordOtherParty: false,
      bookmarks: [
        { id: 'b1', atMs: 1000, text: "the buyer's actual words", createdAt: new Date().toISOString() }
      ]
    })
    const call = await getCall(dir, 'bookmarks-no-consent')
    expect(call?.bookmarks).toEqual([])
  })

  it('keeps bookmarks once consent is actually held', async () => {
    await writeRawCall({
      id: 'bookmarks-consented',
      segments: [{ speaker: 0, channel: 0, text: 'rep line' }],
      speakerIdentities: {},
      recordOtherParty: true,
      bookmarks: [{ id: 'b1', atMs: 1000, text: 'a clipped moment', createdAt: new Date().toISOString() }]
    })
    const call = await getCall(dir, 'bookmarks-consented')
    expect(call?.bookmarks).toHaveLength(1)
    expect(call?.bookmarks?.[0]?.text).toBe('a clipped moment')
  })
})
