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
vi.mock('../../memory/memory-runtime', () => ({
  getMemoryDb: () => null,
  ensureMemoryDb: async () => ({ db: null, detail: 'disabled' })
}))
vi.mock('../../memory/memories-store', () => ({ getMemoryById: () => null }))
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
vi.mock('../../coaching-chat', () => ({
  extractContextSuggestions: vi.fn(async () => [
    { id: 'sug-mem', type: 'memory', text: 'fact', confidence: 'high', memoryScope: 'rep', memoryCategory: 'preference' },
    { id: 'sug-kyc', type: 'kyc', field: 'timeline', text: 'x', confidence: 'high' }
  ])
}))

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
      { kind: 'memory', id: 'mem-9', label: 'Rep excels at discovery' }
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
