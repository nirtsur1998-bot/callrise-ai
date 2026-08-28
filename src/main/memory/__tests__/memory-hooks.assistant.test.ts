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
  consolidated: [] as unknown[],
  candidateCount: 1,
  /** Test hooks simulating the user acting DURING the async AI steps. */
  onExtractResolved: null as (() => void) | null,
  onConsolidate: null as (() => void) | null,
  storedByCall: [] as { id: string }[],
  deleted: [] as string[]
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
    state.onExtractResolved?.()
    return {
      candidates: Array.from({ length: state.candidateCount }, (_, i) => ({
        scope: 'rep',
        category: 'preference',
        statement: `x${i}`,
        evidence: [],
        confidence: 0.4,
        importance: 5,
        source: 'auto'
      })),
      aiFailed: false
    }
  }
}))
vi.mock('../consolidation', () => ({
  consolidateNewCandidate: async (_db: unknown, candidate: unknown) => {
    state.consolidated.push(candidate)
    state.onConsolidate?.()
    return 'created'
  },
  runLightConsolidation: async () => {}
}))
vi.mock('../memories-store', () => ({
  listMemoriesByCallId: () => state.storedByCall,
  deleteMemory: (_db: unknown, id: string) => {
    state.deleted.push(id)
    return true
  },
  // AUDIT FIX (2026-08-24) — mirrors forgetCallContribution's real
  // semantics (prune this source's evidence; delete only when it was the
  // last) rather than stubbing it, so the assertions below still mean
  // something. The store's own semantics are covered for real against a
  // migrated database in exclusion-forgets.test.ts; this mock exists only so
  // the HOOK's sweep can be observed.
  forgetCallContribution: (_db: unknown, callId: string) => {
    let deleted = 0
    let pruned = 0
    for (const m of state.storedByCall as { id: string; evidence?: { type?: string; callId?: string }[] }[]) {
      const remaining = (m.evidence ?? []).filter(
        (e) => !(e.type === 'transcript' && e.callId === callId)
      )
      if (remaining.length === 0) {
        state.deleted.push(m.id)
        deleted++
      } else {
        pruned++
      }
    }
    return { deleted, pruned }
  }
}))

import { runMemoryExtractionForAssistantMessage } from '../memory-hooks'

beforeEach(() => {
  state.salesBrainEnabled = true
  state.conversation = { id: 'conv-1', salesBrainExcluded: undefined }
  state.extractCalls = []
  state.consolidated = []
  state.candidateCount = 1
  state.onExtractResolved = null
  state.onConsolidate = null
  state.storedByCall = []
  state.deleted = []
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

describe('audit V1 — consent checked AT WRITE TIME, not just at hook start', () => {
  it('exclusion set DURING the extraction AI call blocks every insert', async () => {
    // The user clicks "Not learning" while the AI round trip is in flight:
    // the flag flips between the start-gate and the first insert.
    state.onExtractResolved = () => {
      state.conversation = { id: 'conv-1', salesBrainExcluded: true }
    }
    await runMemoryExtractionForAssistantMessage('conv-1', 'msg-9', 'secret detail')
    expect(state.extractCalls).toHaveLength(1) // extraction had already started — fine
    expect(state.consolidated).toHaveLength(0) // but NOTHING may be written
  })

  it('exclusion set DURING a consolidation step stops the rest and sweeps what landed', async () => {
    state.candidateCount = 3
    state.onConsolidate = () => {
      // Flips while the first candidate's own AI judge is "in flight" —
      // after its insert, before the next per-candidate permission check.
      state.conversation = { id: 'conv-1', salesBrainExcluded: true }
      state.storedByCall = [{ id: 'leaked-1' }]
    }
    await runMemoryExtractionForAssistantMessage('conv-1', 'msg-9', 'multi-fact message')
    expect(state.consolidated).toHaveLength(1) // candidates 2 and 3 blocked
    expect(state.deleted).toEqual(['leaked-1']) // and the landed one swept
  })
})
