// M28 Phase 2 — chat-as-a-memory-source consent invariants, same stakes as
// memory-hooks.client-scope.test.ts: what an assistant conversation may
// teach the Sales Brain, and that "don't learn from this" actually stops it.
//
// Three properties, each a standing rule from the milestone brief:
//   1. contactId is null UNCONDITIONALLY — a global chat can never store
//      client-scoped memories (structural, not behavioral).
//   2. Permissions (master flag + the conversation's own exclusion) are read
//      FRESH at execution: flipping either before the hook runs stops it.
//   3. Evidence uses the `assistant:<conversationId>` callId convention, so
//      the retroactive forget and Memory Center lookups work unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  salesBrainEnabled: true,
  conversation: null as unknown,
  extractCalls: [] as Array<{ callId: string; chatMessageId: string; contactId: string | null }>,
  consolidated: [] as unknown[]
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/callrise-test' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    on(): void {}
    show(): void {}
  }
}))
vi.mock('../../app-settings', () => ({
  isSalesBrainEnabled: () => state.salesBrainEnabled,
  isJobNativeNotificationsEnabled: () => false
}))
vi.mock('../../calls-fs', () => ({ getCall: async () => null }))
vi.mock('../../live/live-transcript', () => ({ liveCallInfo: () => null }))
vi.mock('../../assistant/conversations-fs', () => ({
  conversationsDir: (d: string) => d,
  getConversation: async () => state.conversation
}))
vi.mock('../memory-runtime', () => ({ getMemoryDb: () => ({}) }))
vi.mock('../extraction', () => ({
  extractMemoriesFromCall: async () => ({ candidates: [], aiFailed: false }),
  extractMemoriesFromChatMessage: async (
    _message: string,
    callId: string,
    chatMessageId: string,
    contactId: string | null
  ) => {
    state.extractCalls.push({ callId, chatMessageId, contactId })
    return {
      candidates: [
        {
          scope: 'rep',
          category: 'preference',
          statement: 'x',
          evidence: [],
          confidence: 0.4,
          importance: 5,
          source: 'auto'
        }
      ],
      aiFailed: false
    }
  }
}))
vi.mock('../consolidation', () => ({
  consolidateNewCandidate: async (_db: unknown, candidate: unknown) => {
    state.consolidated.push(candidate)
    return 'created'
  },
  runLightConsolidation: async () => {}
}))

import { runMemoryExtractionForAssistantMessage } from '../memory-hooks'

beforeEach(() => {
  state.salesBrainEnabled = true
  state.conversation = { id: 'conv-1', salesBrainExcluded: undefined }
  state.extractCalls = []
  state.consolidated = []
})

describe('runMemoryExtractionForAssistantMessage — consent invariants', () => {
  it('extracts with contactId null UNCONDITIONALLY and the assistant: callId convention', async () => {
    await runMemoryExtractionForAssistantMessage('conv-1', 'msg-9', 'we use HubSpot')
    expect(state.extractCalls).toEqual([
      { callId: 'assistant:conv-1', chatMessageId: 'msg-9', contactId: null }
    ])
    expect(state.consolidated).toHaveLength(1)
  })

  it('an excluded conversation never reaches extraction (permission read fresh)', async () => {
    state.conversation = { id: 'conv-1', salesBrainExcluded: true }
    await runMemoryExtractionForAssistantMessage('conv-1', 'msg-9', 'secret')
    expect(state.extractCalls).toHaveLength(0)
    expect(state.consolidated).toHaveLength(0)
  })

  it('master flag off stops everything before any read', async () => {
    state.salesBrainEnabled = false
    await runMemoryExtractionForAssistantMessage('conv-1', 'msg-9', 'anything')
    expect(state.extractCalls).toHaveLength(0)
  })

  it('a deleted/missing conversation extracts nothing', async () => {
    state.conversation = null
    await runMemoryExtractionForAssistantMessage('conv-gone', 'msg-9', 'anything')
    expect(state.extractCalls).toHaveLength(0)
  })
})
