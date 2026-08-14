// M27 — the post-call "Sales Brain learned N things" notification used to
// construct its own `new Notification(...)` directly, bypassing BOTH gates
// every job-system notification respects: the user's notification setting,
// and the job system's own stated HARD RULE that no OS popup may fire while
// a live call is active (jobs/activity.ts's header).
//
// Always latent — post-call extraction for call A routinely completes while
// the rep is already on call B — but quota-pressure deferral makes it far
// likelier: a backlog of held extractions releases together when capacity
// returns, turning one stray popup into a burst of them, possibly mid-call.
//
// These drive the REAL runMemoryExtractionForCall through to the real
// notification decision, with only the surrounding I/O mocked, so they prove
// the gates are actually wired rather than describing them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  liveCall: null as { callId: string } | null,
  notificationsEnabled: true,
  shown: [] as Array<{ title: string; body: string }>
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/callrise-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../notifications', () => ({
  showNativeNotification: (opts: { title: string; body: string }) => {
    state.shown.push({ title: opts.title, body: opts.body })
  }
}))

vi.mock('../../live/live-transcript', () => ({
  liveCallInfo: () => state.liveCall
}))

vi.mock('../../app-settings', () => ({
  isSalesBrainEnabled: () => true,
  isJobNativeNotificationsEnabled: () => state.notificationsEnabled
}))

vi.mock('../../calls-fs', () => ({
  getCall: async () => ({
    id: 'call-1',
    segments: [{ speaker: 0, text: 'we need this by Q3' }],
    salesBrainExcluded: false,
    contactId: null
  })
}))

vi.mock('../memory-runtime', () => ({ getMemoryDb: () => ({}) }))

vi.mock('../extraction', () => ({
  // One real candidate, so the notification path is genuinely reached —
  // "learned nothing" returns early and would prove nothing about gating.
  extractMemoriesFromCall: async () => ({
    candidates: [{ scope: 'rep', statement: 'wants Q3 delivery' }],
    aiFailed: false
  }),
  extractMemoriesFromChatMessage: async () => ({ candidates: [], aiFailed: false })
}))

vi.mock('../consolidation', () => ({
  consolidateNewCandidate: async () => 'created', // counts toward newCount
  runLightConsolidation: async () => {}
}))

const { runMemoryExtractionForCall } = await import('../memory-hooks')

beforeEach(() => {
  state.liveCall = null
  state.notificationsEnabled = true
  state.shown = []
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('the post-call learned notification respects the app\'s own gates', () => {
  it('fires normally when no call is live and notifications are on', async () => {
    await runMemoryExtractionForCall('call-1', { pass: 'post-save' })
    expect(state.shown).toHaveLength(1)
    expect(state.shown[0].title).toBe('Sales Brain learned something')
  })

  it('is SUPPRESSED while a live call is in progress — the job system\'s hard DND rule', async () => {
    state.liveCall = { callId: 'some-other-call' }
    await runMemoryExtractionForCall('call-1', { pass: 'post-save' })
    expect(state.shown).toEqual([])
  })

  it('is suppressed when the user has turned job notifications off', async () => {
    state.notificationsEnabled = false
    await runMemoryExtractionForCall('call-1', { pass: 'post-save' })
    expect(state.shown).toEqual([])
  })

  it('the memories are still saved when the popup is suppressed — only the interruption is dropped', async () => {
    // The point of suppressing rather than buffering: nothing is lost. The
    // extraction still ran and still consolidated; the rep reviews it in
    // Memory Center whenever they choose.
    const consolidation = await import('../consolidation')
    const spy = vi.spyOn(consolidation, 'consolidateNewCandidate')
    state.liveCall = { callId: 'some-other-call' }
    await runMemoryExtractionForCall('call-1', { pass: 'post-save' })
    expect(state.shown).toEqual([])
    expect(spy).toHaveBeenCalled()
  })
})
