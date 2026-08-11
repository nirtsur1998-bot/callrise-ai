import { describe, expect, it } from 'vitest'
import { resolveCascade, type ContactLookup, type ResolveInput } from '../resolve'

const CALL_START = new Date(2026, 0, 15, 10, 0, 0).getTime()

const NO_CONTACTS: ContactLookup = { findByEmail: async () => null }

function baseInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    segments: [
      { speaker: 0, channel: 0 },
      { speaker: 1, channel: 1 }
    ],
    multichannel: true,
    repSpeaker: null,
    userName: 'Alex Rep',
    call: { startedAtMs: CALL_START, durationMs: 20 * 60_000 },
    calendarEvents: [],
    ...overrides
  }
}

const oneOnOneEvent = {
  title: 'Q3 renewal',
  start: new Date(2026, 0, 15, 10, 0, 0).toISOString(),
  end: new Date(2026, 0, 15, 10, 30, 0).toISOString(),
  allDay: false,
  attendees: [{ email: 'sarah.chen@acme.com', name: 'Sarah Chen' }]
}

describe('resolveCascade — step 1 (user profile)', () => {
  it('resolves "me" on channel 0 for a multichannel call', async () => {
    const result = await resolveCascade(baseInput(), NO_CONTACTS)
    expect(result['ch0/spk0']).toMatchObject({ name: 'Alex Rep', source: 'user-profile', confidence: 'high' })
  })

  it('resolves "me" via repSpeaker for a mono call', async () => {
    const result = await resolveCascade(
      baseInput({
        multichannel: false,
        repSpeaker: 0,
        segments: [
          { speaker: 0 },
          { speaker: 1 }
        ]
      }),
      NO_CONTACTS
    )
    expect(result['mono/spk0']).toMatchObject({ name: 'Alex Rep', source: 'user-profile' })
  })

  it('does not resolve "me" for a mono call with unknown repSpeaker', async () => {
    const result = await resolveCascade(
      baseInput({ multichannel: false, repSpeaker: null, segments: [{ speaker: 0 }, { speaker: 1 }] }),
      NO_CONTACTS
    )
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('skips step 1 with no user name known', async () => {
    const result = await resolveCascade(baseInput({ userName: null }), NO_CONTACTS)
    expect(result['ch0/spk0']).toBeUndefined()
  })
})

describe('resolveCascade — steps 2-3 (calendar + contact)', () => {
  it('resolves the single other party via a 1:1 calendar match', async () => {
    const result = await resolveCascade(baseInput({ calendarEvents: [oneOnOneEvent] }), NO_CONTACTS)
    expect(result['ch1/spk1']).toMatchObject({
      name: 'Sarah Chen',
      source: 'calendar',
      confidence: 'high'
    })
  })

  it('prefers the CONTACT name over the calendar invite name when the email matches a saved contact', async () => {
    const contacts: ContactLookup = {
      findByEmail: async (email) =>
        email === 'sarah.chen@acme.com' ? { id: 'contact-1', name: 'Sarah Chen-Martinez' } : null
    }
    const result = await resolveCascade(baseInput({ calendarEvents: [oneOnOneEvent] }), contacts)
    expect(result['ch1/spk1']).toMatchObject({
      name: 'Sarah Chen-Martinez',
      source: 'contact',
      confidence: 'high',
      contactId: 'contact-1'
    })
  })

  it('falls back to the email local-part when the calendar attendee has no display name', async () => {
    const event = { ...oneOnOneEvent, attendees: [{ email: 'jane.doe@acme.com' }] }
    const result = await resolveCascade(baseInput({ calendarEvents: [event] }), NO_CONTACTS)
    expect(result['ch1/spk1']).toMatchObject({ name: 'Jane Doe', source: 'calendar' })
  })

  it('never guesses when more than one non-rep speaker is observed', async () => {
    const result = await resolveCascade(
      baseInput({
        multichannel: false,
        repSpeaker: 0,
        segments: [{ speaker: 0 }, { speaker: 1 }, { speaker: 2 }],
        calendarEvents: [oneOnOneEvent]
      }),
      NO_CONTACTS
    )
    // Only "me" resolves; the two other distinct speakers stay unresolved
    // rather than both being (wrongly) labeled with the one calendar name.
    expect(result['mono/spk1']).toBeUndefined()
    expect(result['mono/spk2']).toBeUndefined()
  })

  it('leaves the other party unresolved with no overlapping calendar event', async () => {
    const farEvent = {
      ...oneOnOneEvent,
      start: new Date(2026, 0, 15, 20, 0, 0).toISOString(),
      end: new Date(2026, 0, 15, 20, 30, 0).toISOString()
    }
    const result = await resolveCascade(baseInput({ calendarEvents: [farEvent] }), NO_CONTACTS)
    expect(result['ch1/spk1']).toBeUndefined()
  })

  it('leaves the other party unresolved for a group calendar meeting', async () => {
    const groupEvent = {
      ...oneOnOneEvent,
      attendees: [
        { email: 'sarah.chen@acme.com', name: 'Sarah Chen' },
        { email: 'bob@acme.com', name: 'Bob' }
      ]
    }
    const result = await resolveCascade(baseInput({ calendarEvents: [groupEvent] }), NO_CONTACTS)
    expect(result['ch1/spk1']).toBeUndefined()
  })

  it('resolves both "me" and the other party together in one call', async () => {
    const result = await resolveCascade(baseInput({ calendarEvents: [oneOnOneEvent] }), NO_CONTACTS)
    expect(Object.keys(result).sort()).toEqual(['ch0/spk0', 'ch1/spk1'])
  })
})

describe('resolveCascade — never invents an identity for an unobserved speaker', () => {
  it('only resolves keys that actually appear in segments', async () => {
    const result = await resolveCascade(
      baseInput({
        // Only channel 0 was ever observed (e.g. buyer channel silent the
        // whole call) — there must be no ch1/spk1 entry even if a perfect
        // calendar match exists.
        segments: [{ speaker: 0, channel: 0 }],
        calendarEvents: [oneOnOneEvent]
      }),
      NO_CONTACTS
    )
    expect(result['ch1/spk1']).toBeUndefined()
    expect(Object.keys(result)).toEqual(['ch0/spk0'])
  })
})

describe('resolveCascade — mid-call mono<->multichannel switch (regression)', () => {
  // A call that started mono (diarize) and later had "enable buyer capture"
  // clicked mid-call ends up with BOTH mono/spkN segments (pre-switch) and
  // chN/spkN segments (post-switch) in the same segments array. Resolution
  // must judge "how many other speakers" using ONLY the current regime's
  // keys — a stale mono key must never inflate the count and defeat an
  // otherwise-clean 1:1 match.
  it('ignores stale mono keys and still resolves a genuine post-switch 1:1', async () => {
    const result = await resolveCascade(
      baseInput({
        multichannel: true,
        segments: [
          // Pre-switch: two mono-diarized speakers.
          { speaker: 0 },
          { speaker: 1 },
          // Post-switch: the current multichannel regime, a clean 1:1.
          { speaker: 0, channel: 0 },
          { speaker: 1, channel: 1 }
        ],
        calendarEvents: [oneOnOneEvent]
      }),
      NO_CONTACTS
    )
    expect(result['ch1/spk1']).toMatchObject({ name: 'Sarah Chen', source: 'calendar' })
    // The stale pre-switch mono keys never get an entry of their own.
    expect(result['mono/spk0']).toBeUndefined()
    expect(result['mono/spk1']).toBeUndefined()
  })

  it('does not treat the sole observed speaker as "the other party" when repSpeaker is unknown', async () => {
    // Very first pass of a mono call, before coaching has set repSpeaker:
    // only one speaker has been diarized so far. Being the ONLY one to
    // speak makes them far more likely to be the rep than a not-yet-heard
    // buyer, so this must resolve nothing rather than guess.
    const result = await resolveCascade(
      baseInput({
        multichannel: false,
        repSpeaker: null,
        segments: [{ speaker: 0 }],
        calendarEvents: [oneOnOneEvent]
      }),
      NO_CONTACTS
    )
    expect(Object.keys(result)).toHaveLength(0)
  })
})
