// M28 — the assistant turn engine, driven through the REAL IPC handlers and
// the REAL conversation store in a temp dir. Only electron, the AI walk, the
// memory layer, and the suggestion extractor are stubbed. What these tests
// prove: streaming deltas broadcast, complete turns persist with parsed
// citations, busy/cancel/attach semantics, and — the two M28 design claims —
// a Stop keeps already-streamed words, and an in-flight turn is recoverable
// by a remounting renderer (main owns the turn).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const broadcasts: { channel: string; payload: unknown }[] = []

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn)
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => broadcasts.push({ channel, payload })
        }
      }
    ]
  }
}))

// Controllable fake stream: tests push deltas / end / fail explicitly.
type Waiter = { resolve: (v: IteratorResult<{ delta: string }>) => void; reject: (e: unknown) => void }
const streamControl = vi.hoisted(() => ({
  queue: [] as { delta: string }[],
  waiters: [] as Waiter[],
  done: false,
  error: null as unknown,
  signal: null as AbortSignal | null,
  lastRequest: null as Record<string, unknown> | null,
  reset(): void {
    this.queue = []
    this.waiters = []
    this.done = false
    this.error = null
    this.signal = null
    this.lastRequest = null
  },
  push(delta: string): void {
    const w = this.waiters.shift()
    if (w) w.resolve({ value: { delta }, done: false })
    else this.queue.push({ delta })
  },
  end(): void {
    this.done = true
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true })
  },
  fail(err: unknown): void {
    this.error = err
    for (const w of this.waiters.splice(0)) w.reject(err)
  }
}))

vi.mock('../../ai/complete-with-fallback', () => ({
  AllModelsExhaustedError: class AllModelsExhaustedError extends Error {},
  streamWithFallback: (req: Record<string, unknown>) => {
    streamControl.lastRequest = req
    streamControl.signal = (req.signal as AbortSignal) ?? null
    streamControl.signal?.addEventListener('abort', () => streamControl.fail(new Error('aborted')))
    const iterable = {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<{ delta: string }>> => {
          if (streamControl.queue.length > 0) {
            return Promise.resolve({ value: streamControl.queue.shift()!, done: false })
          }
          if (streamControl.error) return Promise.reject(streamControl.error)
          if (streamControl.done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => streamControl.waiters.push({ resolve, reject }))
        }
      })
    }
    return Object.assign(iterable, {
      final: Promise.resolve({ text: '', model: 'fake', usage: null }).catch(() => {})
    })
  }
}))
vi.mock('../../ai', () => ({ AIProviderError: class AIProviderError extends Error {} }))
vi.mock('../../memory/profile-injection', () => ({
  repProfileSection: () => '--- REP (Sales Brain) ---\n- closes fast',
  businessProfileSection: () => ''
}))
vi.mock('../../memory/rag', () => ({
  retrieveRelevantMemoriesStructured: vi.fn(async () => [
    {
      memory: {
        id: 'mem-9',
        scope: 'rep',
        category: 'selling-pattern',
        statement: 'Rep excels at discovery',
        evidence: [],
        confidence: 0.8,
        importance: 5,
        status: 'active',
        source: 'auto',
        pinned: false,
        createdAt: 'x',
        lastConfirmedAt: 'x'
      },
      distance: 0.1
    }
  ])
}))
vi.mock('../../memory/consolidation', () => ({ consolidateNewCandidate: vi.fn(async () => 'created') }))
const brainMock = vi.hoisted(() => ({ enabled: true, dbAvailable: true }))
vi.mock('../../memory/memory-runtime', () => ({
  getMemoryDb: () => (brainMock.dbAvailable ? { fake: 'db' } : null),
  ensureMemoryDb: async () => ({
    db: brainMock.dbAvailable ? { fake: 'db' } : null,
    detail: 'x'
  })
}))
const memStore = vi.hoisted(() => ({
  byCall: [] as { id: string }[],
  deleted: [] as string[],
  extraction: vi.fn(async (): Promise<void> => {})
}))
vi.mock('../../memory/memories-store', () => ({
  getMemoryById: () => null,
  listMemoriesByCallId: (_db: unknown, callId: string) =>
    callId.startsWith('assistant:') ? memStore.byCall : [],
  deleteMemory: (_db: unknown, id: string) => {
    memStore.deleted.push(id)
    return true
  }
}))
vi.mock('../../memory/memory-hooks', () => ({
  runMemoryExtractionForAssistantMessage: memStore.extraction
}))
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => brainMock.enabled }))
const toolsMock = vi.hoisted(() => ({
  plan: vi.fn(async (): Promise<unknown[]> => []),
  execute: vi.fn(
    async (): Promise<{ sections: unknown[]; taskProposals: unknown[] }> => ({
      sections: [],
      taskProposals: []
    })
  )
}))
vi.mock('../tools', () => ({
  planLookups: toolsMock.plan,
  executeLookups: toolsMock.execute,
  defaultToolDirs: () => ({ callsDir: '', contactsDir: '', dealsDir: '', eventsDir: '' })
}))
const taskMock = vi.hoisted(() => ({
  create: vi.fn(async (): Promise<{ id: string }> => ({ id: 'task-1' }))
}))
vi.mock('../../tasks-fs', () => ({ createTask: taskMock.create }))
vi.mock('../../backup', () => ({ scheduleBackup: vi.fn() }))
const suggestMock = vi.hoisted(() => ({
  extract: vi.fn(async () => [
    { id: 'sug-mem', type: 'memory', text: 'fact', confidence: 'high', memoryScope: 'rep', memoryCategory: 'preference' },
    { id: 'sug-kyc', type: 'kyc', field: 'timeline', text: 'x', confidence: 'high' }
  ])
}))
vi.mock('../../coaching-chat', () => ({ extractContextSuggestions: suggestMock.extract }))

import { getConversation } from '../conversations-fs'
import { inFlightCountForTests } from '../assistant-ipc'

async function setup(): Promise<{
  convId: string
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}> {
  const { registerAssistant } = await import('../assistant-ipc')
  ipcHandlers.clear()
  registerAssistant()
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(ipcHandlers.get(channel)!({}, ...args))
  const conv = (await invoke('assistant:createConversation')) as { id: string }
  return { convId: conv.id, invoke }
}

function convDir(): string {
  return join(dir, 'assistant-conversations')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assistant-ipc-test-'))
  broadcasts.length = 0
  streamControl.reset()
  toolsMock.plan.mockClear()
  toolsMock.execute.mockClear()
  toolsMock.execute.mockResolvedValue({ sections: [], taskProposals: [] })
  taskMock.create.mockClear()
  taskMock.create.mockResolvedValue({ id: 'task-1' })
  memStore.byCall = []
  memStore.deleted = []
  memStore.extraction.mockClear()
  brainMock.enabled = true
  brainMock.dbAvailable = true
  suggestMock.extract.mockClear()
  vi.resetModules()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('assistant:send', () => {
  it('streams deltas, persists the complete turn with parsed citations, filters chips to memory', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'What am I good at?')
    streamControl.push('You excel at discovery ')
    streamControl.push('[1].')
    streamControl.end()
    const result = (await pending) as Record<string, unknown>

    expect(result.ok).toBe(true)
    expect(result.reply).toBe('You excel at discovery [1].')
    // Deltas were broadcast as they arrived, tagged with the conversation.
    const deltas = broadcasts.filter((b) => b.channel === 'assistant:delta')
    expect(deltas).toHaveLength(2)
    expect((deltas[0].payload as { conversationId: string }).conversationId).toBe(convId)
    // Citation [1] resolved against the retrieved memory.
    expect(result.citations).toEqual([
      { kind: 'memory', id: 'mem-9', label: 'Rep excels at discovery', marker: 1 }
    ])
    // kyc chip filtered out on the global surface; memory chip kept.
    expect((result.suggestions as { id: string }[]).map((s) => s.id)).toEqual(['sug-mem'])
    // Turn persisted to disk, complete, with citations + suggestions.
    const conv = await getConversation(convDir(), convId)
    expect(conv?.messages).toHaveLength(2)
    expect(conv?.messages[1].citations?.[0].id).toBe('mem-9')
    expect(conv?.messages[0].suggestions?.[0].id).toBe('sug-mem')
    expect(inFlightCountForTests()).toBe(0)
  })

  it('rejects a second send while one is in flight (busy), then frees the slot', async () => {
    const { convId, invoke } = await setup()
    const first = invoke('assistant:send', convId, 'one')
    const second = (await invoke('assistant:send', convId, 'two')) as Record<string, unknown>
    expect(second.ok).toBe(false)
    expect(second.error).toBe('busy')
    streamControl.end()
    await first
    expect(inFlightCountForTests()).toBe(0)
  })

  it('an empty reply is a failure, not a phantom turn (sanitize-on-read would drop it)', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'q')
    streamControl.end() // zero tokens, "successful" stream
    const result = (await pending) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toBe('ai-failed')
    expect((await getConversation(convDir(), convId))?.messages).toHaveLength(0)
  })

  it('a provider failure persists nothing and reports the friendly message', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'q')
    streamControl.fail(new Error('boom'))
    const result = (await pending) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toBe('ai-failed')
    expect(broadcasts.some((b) => b.channel === 'assistant:error')).toBe(true)
    expect((await getConversation(convDir(), convId))?.messages).toHaveLength(0)
  })
})

describe('audit V6 — chips are never OFFERED when they cannot save', () => {
  async function sendOne(convId: string, invoke: (c: string, ...a: unknown[]) => Promise<unknown>): Promise<Record<string, unknown>> {
    const pending = invoke('assistant:send', convId, 'we use HubSpot')
    streamControl.push('Noted.')
    streamControl.end()
    return (await pending) as Record<string, unknown>
  }

  it('Sales Brain OFF: no chips, and the suggestion AI call is never made', async () => {
    const { convId, invoke } = await setup()
    brainMock.enabled = false
    const result = await sendOne(convId, invoke)
    expect(result.suggestions).toEqual([])
    expect(suggestMock.extract).not.toHaveBeenCalled()
  })

  it('memory db unavailable: same — no dead chips', async () => {
    const { convId, invoke } = await setup()
    brainMock.dbAvailable = false
    const result = await sendOne(convId, invoke)
    expect(result.suggestions).toEqual([])
    expect(suggestMock.extract).not.toHaveBeenCalled()
  })

  it('"Not learning" conversation: chips suppressed too', async () => {
    const { convId, invoke } = await setup()
    const { setConversationSalesBrainExcluded } = await import('../conversations-fs')
    await setConversationSalesBrainExcluded(convDir(), convId, true)
    const result = await sendOne(convId, invoke)
    expect(result.suggestions).toEqual([])
    expect(suggestMock.extract).not.toHaveBeenCalled()
  })
})

describe('task proposals — writes are confirmed, never executed by the turn', () => {
  it('a proposed task persists on the message as pending; the turn creates NO task', async () => {
    const { convId, invoke } = await setup()
    toolsMock.execute.mockResolvedValueOnce({
      sections: [],
      taskProposals: [{ id: 'prop-1', title: 'Send the quote', type: 'email', priority: 'high' }]
    })
    const pending = invoke('assistant:send', convId, 'remind me to send the quote')
    streamControl.push('Will do — confirm below.')
    streamControl.end()
    await pending
    expect(taskMock.create).not.toHaveBeenCalled()
    const conv = await getConversation(convDir(), convId)
    expect(conv?.messages[1].taskProposals).toEqual([
      { id: 'prop-1', title: 'Send the quote', type: 'email', priority: 'high', status: 'pending' }
    ])
  })

  it('confirmTask creates the task exactly once; a second confirm is refused', async () => {
    const { convId, invoke } = await setup()
    toolsMock.execute.mockResolvedValueOnce({
      sections: [],
      taskProposals: [{ id: 'prop-1', title: 'Send the quote', type: 'email', priority: 'high' }]
    })
    const pending = invoke('assistant:send', convId, 'q')
    streamControl.push('Confirm below.')
    streamControl.end()
    await pending
    const msgId = (await getConversation(convDir(), convId))!.messages[1].id

    const first = (await invoke('assistant:confirmTask', convId, msgId, 'prop-1')) as { ok: boolean }
    expect(first.ok).toBe(true)
    expect(taskMock.create).toHaveBeenCalledOnce()
    expect((await getConversation(convDir(), convId))?.messages[1].taskProposals?.[0].status).toBe(
      'accepted'
    )

    const second = (await invoke('assistant:confirmTask', convId, msgId, 'prop-1')) as { ok: boolean }
    expect(second.ok).toBe(false)
    expect(taskMock.create).toHaveBeenCalledOnce() // still once — no double-create
  })

  it('a failed create rolls the proposal back to pending so the user can retry', async () => {
    const { convId, invoke } = await setup()
    toolsMock.execute.mockResolvedValueOnce({
      sections: [],
      taskProposals: [{ id: 'prop-1', title: 'T', type: 'general', priority: 'medium' }]
    })
    const pending = invoke('assistant:send', convId, 'q')
    streamControl.push('Confirm below.')
    streamControl.end()
    await pending
    const msgId = (await getConversation(convDir(), convId))!.messages[1].id

    taskMock.create.mockRejectedValueOnce(new Error('disk full'))
    const result = (await invoke('assistant:confirmTask', convId, msgId, 'prop-1')) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect((await getConversation(convDir(), convId))?.messages[1].taskProposals?.[0].status).toBe(
      'pending'
    )
  })
})

describe('voice notes — attachment + cleanup', () => {
  it('a send carrying a voice note persists it on the user message', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'dictated text', {
      mediaId: 'aaaa-1111.webm',
      durationMs: 4200
    })
    streamControl.push('Got it.')
    streamControl.end()
    await pending
    const conv = await getConversation(convDir(), convId)
    expect(conv?.messages[0].voiceNote).toEqual({ mediaId: 'aaaa-1111.webm', durationMs: 4200 })
  })

  it('a malformed voiceNote argument is dropped, not persisted', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'text', { mediaId: '../evil.webm', durationMs: 1 })
    streamControl.push('ok')
    streamControl.end()
    await pending
    expect((await getConversation(convDir(), convId))?.messages[0].voiceNote).toBeUndefined()
  })
})

describe('chat as a memory source — wiring + retroactive forget', () => {
  it('a successful turn fires the extraction hook with the persisted user-message id', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'we use HubSpot for CRM')
    streamControl.push('Noted.')
    streamControl.end()
    await pending
    expect(memStore.extraction).toHaveBeenCalledOnce()
    const [gotConvId, gotMsgId, gotMessage] = memStore.extraction.mock.calls[0] as unknown as [
      string,
      string,
      string
    ]
    expect(gotConvId).toBe(convId)
    expect(gotMessage).toBe('we use HubSpot for CRM')
    const conv = await getConversation(convDir(), convId)
    expect(gotMsgId).toBe(conv?.messages[0].id) // the REAL persisted id, not a local one
  })

  it('a failed turn fires no extraction', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'q')
    streamControl.fail(new Error('boom'))
    await pending
    expect(memStore.extraction).not.toHaveBeenCalled()
  })

  it('honesty: excluding with the memory db unavailable FAILS CLOSED — flag not set', async () => {
    const { convId, invoke } = await setup()
    brainMock.dbAvailable = false
    const res = (await invoke('assistant:setSalesBrainExcluded', convId, true)) as {
      ok: boolean
      message?: string
    }
    expect(res.ok).toBe(false)
    expect(res.message).toContain('cannot be forgotten')
    expect((await getConversation(convDir(), convId))?.salesBrainExcluded).toBeUndefined()
  })

  it('excluding a conversation persists the flag and deletes everything it taught', async () => {
    const { convId, invoke } = await setup()
    memStore.byCall = [{ id: 'mem-1' }, { id: 'mem-2' }]
    const res = (await invoke('assistant:setSalesBrainExcluded', convId, true)) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(memStore.deleted).toEqual(['mem-1', 'mem-2'])
    expect((await getConversation(convDir(), convId))?.salesBrainExcluded).toBe(true)
    // Re-enabling clears the flag and does NOT resurrect anything.
    memStore.deleted = []
    await invoke('assistant:setSalesBrainExcluded', convId, false)
    expect((await getConversation(convDir(), convId))?.salesBrainExcluded).toBeUndefined()
    expect(memStore.deleted).toEqual([])
  })
})

describe('stop and attach — the two M28 design claims', () => {
  it('cancel mid-stream keeps the partial reply as a persisted turn (stopped: true)', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'long question')
    streamControl.push('Partial answer the user already read')
    // Let the delta actually get consumed before aborting.
    await new Promise((r) => setTimeout(r, 10))
    expect(await invoke('assistant:cancel', convId)).toBe(true)
    const result = (await pending) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.stopped).toBe(true)
    expect(result.reply).toBe('Partial answer the user already read')
    const conv = await getConversation(convDir(), convId)
    expect(conv?.messages[1].text).toBe('Partial answer the user already read')
  })

  it('cancel before any token persists nothing (error: cancelled)', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'q')
    await new Promise((r) => setTimeout(r, 10))
    await invoke('assistant:cancel', convId)
    const result = (await pending) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toBe('cancelled')
    expect((await getConversation(convDir(), convId))?.messages).toHaveLength(0)
  })

  it('attach during flight returns the accumulated text; after settle it reports idle', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'the question')
    streamControl.push('So far…')
    await new Promise((r) => setTimeout(r, 10))
    const during = (await invoke('assistant:attach', convId)) as Record<string, unknown>
    expect(during.streaming).toBe(true)
    expect(during.accumulated).toBe('So far…')
    expect(during.pendingUserText).toBe('the question')
    streamControl.end()
    await pending
    const after = (await invoke('assistant:attach', convId)) as Record<string, unknown>
    expect(after.streaming).toBe(false)
  })

  it('audit V3: Stop lands during the PRE-STREAM phase (planning still in flight)', async () => {
    const { convId, invoke } = await setup()
    // Planning hangs until we release it — simulating the multi-second
    // plan_research call on a slow provider.
    let releasePlan: (v: unknown[]) => void = () => {}
    toolsMock.plan.mockImplementationOnce(
      () => new Promise<unknown[]>((r) => (releasePlan = r))
    )
    const pending = invoke('assistant:send', convId, 'wrong question, stop it')
    await new Promise((r) => setTimeout(r, 10))
    // The turn must already be registered: attach sees it, cancel finds it.
    const during = (await invoke('assistant:attach', convId)) as Record<string, unknown>
    expect(during.streaming).toBe(true)
    expect(await invoke('assistant:cancel', convId)).toBe(true)
    releasePlan([])
    const result = (await pending) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.error).toBe('cancelled')
    // The model was never asked for the answer, and nothing was persisted.
    expect(streamControl.lastRequest).toBeNull()
    expect((await getConversation(convDir(), convId))?.messages).toHaveLength(0)
  })

  it('cancel truly aborts the walk: the AbortSignal the engine passed fires', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'q')
    await new Promise((r) => setTimeout(r, 10))
    expect(streamControl.signal?.aborted).toBe(false)
    await invoke('assistant:cancel', convId)
    expect(streamControl.signal?.aborted).toBe(true)
    await pending
  })
})
