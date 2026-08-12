// #27 — the one Batch 5 item gated on its own sign-off, because putting
// extraction behind a queue could change WHAT CLIENT DATA GETS STORED, not
// just when.
//
// The rule, now stated rather than emergent: the post-save pass NEVER stores
// client-scoped memories (facts about the buyer, filed under their contact).
// Only the post-coach pass does. That used to be true only because the
// post-save pass won a race against the contact-detection cascade's AI round
// trip and read a null contactId — a race that queue latency reverses, and
// that was never even reliably true (a call already linked to a contact at
// save time DID store client memories on the first pass).
//
// These prove three separate things:
//   1. The delayed-identification leak the queue would have caused is gone.
//   2. The strict rule holds even when the buyer IS already identified.
//   3. Permission is read FRESH, not frozen — "I turned this off" must stop
//      a queued job, so a snapshotted permission would be its own bug.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  salesBrainEnabled: true,
  call: null as unknown,
  extractCalls: [] as Array<{ contactId: string | null }>
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/callrise-test' },
  BrowserWindow: { getAllWindows: () => [] },
  // Stubbed out entirely — notifyLearnedFromCall's toast is irrelevant here
  // and never fires anyway (these tests produce zero new memories).
  Notification: class {
    on(): void {
      /* no-op */
    }
    show(): void {
      /* no-op */
    }
  }
}))

vi.mock('../../app-settings', () => ({
  isSalesBrainEnabled: () => state.salesBrainEnabled
}))

vi.mock('../../calls-fs', () => ({
  getCall: async () => state.call
}))

vi.mock('../memory-runtime', () => ({
  getMemoryDb: () => ({}) // a truthy stand-in; consolidation is mocked out below
}))

vi.mock('../extraction', () => ({
  extractMemoriesFromCall: async (
    _segments: unknown,
    _callId: string,
    contactId: string | null
  ) => {
    state.extractCalls.push({ contactId })
    return []
  },
  extractMemoriesFromChatMessage: async () => []
}))

vi.mock('../consolidation', () => ({
  consolidateNewCandidate: async () => 'created',
  runLightConsolidation: async () => {}
}))

const { runMemoryExtractionForCall } = await import('../memory-hooks')

/** The contactId extraction was actually handed. null means "no identified
 *  client", which is what makes it drop every client-scoped candidate. */
function contactIdSeenByExtraction(): string | null | undefined {
  return state.extractCalls.at(-1)?.contactId
}

beforeEach(() => {
  state.salesBrainEnabled = true
  state.extractCalls = []
  state.call = { id: 'call-1', segments: [{ speaker: 0, text: 'hi' }], contactId: undefined }
})

describe('post-save pass — never stores client-scoped memories', () => {
  it('passes no client through even when the buyer got identified while the job waited in the queue', async () => {
    // The exact scenario queuing introduces: by the time the job runs, the
    // contact cascade HAS finished and written a contactId. Reading it fresh
    // here is what would leak client memories onto a call that produces none
    // today.
    state.call = { id: 'call-1', segments: [{ speaker: 0, text: 'hi' }], contactId: 'contact-99' }

    await runMemoryExtractionForCall('call-1', { pass: 'post-save' })

    expect(contactIdSeenByExtraction()).toBeNull()
  })

  it('passes no client through when the call was ALREADY linked at save time (the strict rule, no exceptions)', async () => {
    state.call = { id: 'call-1', segments: [{ speaker: 0, text: 'hi' }], contactId: 'contact-42' }

    await runMemoryExtractionForCall('call-1', { pass: 'post-save' })

    // Deliberately narrower than the old behaviour, which DID store client
    // memories for a pre-linked call on this pass. Chosen so the privacy
    // rule states in one sentence with no caveat.
    expect(contactIdSeenByExtraction()).toBeNull()
  })

  it('passes no client through when there is no contact at all (unchanged)', async () => {
    await runMemoryExtractionForCall('call-1', { pass: 'post-save' })
    expect(contactIdSeenByExtraction()).toBeNull()
  })
})

describe('post-coach pass — uses the identification frozen at trigger time', () => {
  it('stores under the contact that was known when the trigger fired', async () => {
    state.call = { id: 'call-1', segments: [{ speaker: 0, text: 'hi' }], contactId: 'contact-7' }

    await runMemoryExtractionForCall('call-1', {
      pass: 'post-coach',
      contactIdAtTrigger: 'contact-7'
    })

    expect(contactIdSeenByExtraction()).toBe('contact-7')
  })

  it('ignores a contact identified LATER, while the job sat in the queue', async () => {
    // Trigger fired with no contact known; one appeared during the wait.
    // The job must store what it would have stored had it run inline.
    state.call = { id: 'call-1', segments: [{ speaker: 0, text: 'hi' }], contactId: 'contact-late' }

    await runMemoryExtractionForCall('call-1', {
      pass: 'post-coach',
      contactIdAtTrigger: null
    })

    expect(contactIdSeenByExtraction()).toBeNull()
  })

  it('does not resurrect a contact that was UNLINKED after the trigger', async () => {
    state.call = { id: 'call-1', segments: [{ speaker: 0, text: 'hi' }], contactId: undefined }

    await runMemoryExtractionForCall('call-1', {
      pass: 'post-coach',
      contactIdAtTrigger: 'contact-3'
    })

    // Faithful to inline behaviour: the trigger-time value is what counts.
    expect(contactIdSeenByExtraction()).toBe('contact-3')
  })
})

describe('permission is read FRESH, never frozen alongside the scope', () => {
  it('extracts nothing when Sales Brain was turned off after the job was queued', async () => {
    state.salesBrainEnabled = false

    await runMemoryExtractionForCall('call-1', {
      pass: 'post-coach',
      contactIdAtTrigger: 'contact-7'
    })

    // Not merely "no client scope" — nothing ran at all. A snapshotted
    // permission would have let this through, silently breaking the promise
    // that turning the feature off actually stops queued work.
    expect(state.extractCalls).toHaveLength(0)
  })

  it('extracts nothing when the call was excluded from Sales Brain after the job was queued', async () => {
    state.call = {
      id: 'call-1',
      segments: [{ speaker: 0, text: 'hi' }],
      contactId: 'contact-7',
      salesBrainExcluded: true
    }

    await runMemoryExtractionForCall('call-1', {
      pass: 'post-coach',
      contactIdAtTrigger: 'contact-7'
    })

    expect(state.extractCalls).toHaveLength(0)
  })

  it('still runs normally when both permissions are intact', async () => {
    await runMemoryExtractionForCall('call-1', {
      pass: 'post-coach',
      contactIdAtTrigger: 'contact-7'
    })
    expect(state.extractCalls).toHaveLength(1)
  })
})
