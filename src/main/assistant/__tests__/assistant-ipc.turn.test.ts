// M28 — the assistant turn engine, driven through the REAL IPC handlers and
// the REAL conversation store in a temp dir. Only electron, the AI walk, the
// memory layer, and the suggestion extractor are stubbed. What these tests
// prove: streaming deltas broadcast, complete turns persist with parsed
// citations, busy/cancel/attach semantics, and — the two M28 design claims —
// a Stop keeps already-streamed words, and an in-flight turn is recoverable
// by a remounting renderer (main owns the turn).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const chainMock = vi.hoisted(() => ({
  configured: 1,
  capable: 1,
  lastNeeds: null as Record<string, unknown> | null
}))
vi.mock('../../ai/complete-with-fallback', () => ({
  AllModelsExhaustedError: class AllModelsExhaustedError extends Error {},
  resolveChain: (_purpose: string, needs: Record<string, unknown>) => {
    chainMock.lastNeeds = needs
    const step = { catalogId: 'x', providerId: 'google', modelId: 'm' }
    return {
      configured: Array.from({ length: chainMock.configured }, () => step),
      capable: Array.from({ length: chainMock.capable }, () => step)
    }
  },
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
  businessProfileSection: () => '',
  clientProfileSection: (contactId: string) => `--- CLIENT ${contactId} (Sales Brain) ---\n- prefers email`
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
  },
  // AUDIT FIX (2026-08-24) — mirrors forgetCallContribution's real
  // semantics (prune this source's evidence; delete only when it was the
  // last) rather than stubbing it, so the assertions below still mean
  // something. The store's own semantics are covered for real against a
  // migrated database in exclusion-forgets.test.ts; this mock exists only so
  // the HOOK's sweep can be observed.
  forgetCallContribution: (_db: unknown, callId: string) => {
    if (!callId.startsWith('assistant:')) return { deleted: 0, pruned: 0 }
    let deleted = 0
    let pruned = 0
    for (const m of memStore.byCall as { id: string; evidence?: { type?: string; callId?: string }[] }[]) {
      const remaining = (m.evidence ?? []).filter(
        (e) => !(e.type === 'transcript' && e.callId === callId)
      )
      if (remaining.length === 0) {
        memStore.deleted.push(m.id)
        deleted++
      } else {
        pruned++
      }
    }
    return { deleted, pruned }
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
  ),
  clientBrief: vi.fn(async (): Promise<unknown[]> => [])
}))
vi.mock('../tools', () => ({
  planLookups: toolsMock.plan,
  executeLookups: toolsMock.execute,
  clientBriefSections: toolsMock.clientBrief,
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
import * as ragMod from '../../memory/rag'

// NOTE (2026-08-24, audit fix): `inFlightCountForTests` used to be imported
// STATICALLY at the top of this file. That binding was useless: beforeEach
// ends with vi.resetModules(), and setup() then obtains the handlers via a
// fresh `await import('../assistant-ipc')` — so the handlers mutate a
// DIFFERENT module instance's `inFlight` map than the static import read.
// The three "no leaked turn" assertions therefore observed a map nobody ever
// wrote to, and were permanently, vacuously 0: removing the
// `inFlight.delete(conversationId)` cleanup left them all green. setup() now
// returns the LIVE instance's counter so those assertions observe the same
// state the product mutates.
async function setup(): Promise<{
  convId: string
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  inFlightCount: () => number
}> {
  const mod = await import('../assistant-ipc')
  ipcHandlers.clear()
  mod.registerAssistant()
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(ipcHandlers.get(channel)!({}, ...args))
  const conv = (await invoke('assistant:createConversation')) as { id: string }
  return { convId: conv.id, invoke, inFlightCount: mod.inFlightCountForTests }
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
  toolsMock.clientBrief.mockClear()
  toolsMock.clientBrief.mockResolvedValue([])
  taskMock.create.mockClear()
  taskMock.create.mockResolvedValue({ id: 'task-1' })
  memStore.byCall = []
  memStore.deleted = []
  memStore.extraction.mockClear()
  brainMock.enabled = true
  brainMock.dbAvailable = true
  suggestMock.extract.mockClear()
  chainMock.configured = 1
  chainMock.capable = 1
  chainMock.lastNeeds = null
  vi.mocked(ragMod.retrieveRelevantMemoriesStructured).mockClear()
  vi.resetModules()
})

describe('M28 Part 4 — client scope: the cross-client invariant (red-check target)', () => {
  it('a scoped conversation retrieves with THAT contactId and narrows every lookup to it', async () => {
    const { invoke } = await setup()
    const conv = (await invoke('assistant:createConversation', {
      contactId: 'acme-1',
      contactName: 'Dana Levy',
      company: 'Acme'
    })) as { id: string; scope?: { contactId: string }; title: string }
    expect(conv.scope?.contactId).toBe('acme-1')
    expect(conv.title).toBe('About Dana Levy')

    const pending = invoke('assistant:send', conv.id, 'what objections has she raised?')
    streamControl.push('Mostly price.')
    streamControl.end()
    await pending

    // Retrieval was asked for THIS client's scope — rag's scope list is built
    // from exactly this id, so no other client scope is ever searched.
    const ragCall = vi.mocked(ragMod.retrieveRelevantMemoriesStructured).mock.calls[0]
    expect((ragCall[1] as { contactId: string | null }).contactId).toBe('acme-1')
    // Every record lookup carried the same narrowing id.
    const executeArgs = toolsMock.execute.mock.calls[0] as unknown[]
    expect(executeArgs[3]).toBe('acme-1')
    // The model was told who the conversation is about.
    expect(String(streamControl.lastRequest?.system)).toContain('ONE CLIENT: Dana Levy at Acme')
  })

  it('an unscoped conversation retrieves with contactId null and no lookup narrowing', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'hello')
    streamControl.push('hi')
    streamControl.end()
    await pending
    const ragCall = vi.mocked(ragMod.retrieveRelevantMemoriesStructured).mock.calls[0]
    expect((ragCall[1] as { contactId: string | null }).contactId).toBeNull()
    expect((toolsMock.execute.mock.calls[0] as unknown[])[3]).toBeUndefined()
  })

  it('a malformed scope is rejected at creation — the conversation is simply unscoped', async () => {
    const { invoke } = await setup()
    const conv = (await invoke('assistant:createConversation', {
      contactId: '../evil',
      contactName: 'x'
    })) as { scope?: unknown }
    expect(conv.scope).toBeUndefined()
  })
})

// AUDIT FIX (2026-08-24) — proves the total prompt bound is actually WIRED
// INTO the send path. prompt-budget.test.ts proves the policy in isolation; a
// correct module that nothing calls is the same hollow shape as a correct
// assertion nothing reads, which is what four of this milestone's tests
// turned out to be.
describe('the total prompt bound is applied to real sends', () => {
  it('a conversation far over the window is trimmed before it reaches a provider', async () => {
    const { convId, invoke } = await setup()
    const { appendTurn } = await import('../conversations-fs')

    // The measured worst case, reproduced: 20 turns x 2 messages x 8,000
    // chars = 320,000 of history (the maximum MAX_HISTORY_MESSAGES and
    // MAX_INBOUND_CHARS allow), PLUS six text attachments at
    // MAX_EXTRACTED_CHARS = 40,000 each. History alone fits; attachments
    // alone fit; the sum does not — which is exactly why capping each input
    // individually was not a bound.
    //
    // Text attachments are the case that mattered: the pre-existing
    // drop-history rule fired only for images and PDFs, so documents stacked
    // on top of a full history.
    const big = 'h'.repeat(8_000)
    for (let i = 0; i < 20; i++) {
      await appendTurn(convDir(), convId, { text: big }, { text: big })
    }

    const attachmentIds: string[] = []
    for (let i = 0; i < 6; i++) {
      const added = (await invoke(
        'assistant:addAttachment',
        `notes-${i}.txt`,
        new TextEncoder().encode('t'.repeat(40_000)).buffer,
        convId
      )) as { ok: boolean; attachment?: { id: string } }
      if (added.ok && added.attachment) attachmentIds.push(added.attachment.id)
    }
    expect(attachmentIds).toHaveLength(6)

    const pending = invoke(
      'assistant:send',
      convId,
      'and finally, what now?',
      undefined,
      attachmentIds
    )
    streamControl.push('ok')
    streamControl.end()
    await pending

    const req = streamControl.lastRequest as {
      system: string
      messages: { content: string }[]
    }
    const total =
      req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)
    const { budgetCharsFor, DEFAULT_CONTEXT_WINDOW_TOKENS } = await import('../prompt-budget')
    const budget = budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS)

    expect(
      total,
      'the send path shipped an oversize prompt — the provider 400s, ' +
        'failure-class calls it structural, and the walk blacklists every ' +
        'model in the chain while re-sending the identical prompt'
    ).toBeLessThanOrEqual(budget)

    // And the trimming must be real, not an artefact of a small fixture.
    expect(req.messages.length).toBeLessThan(41)
    // The user's own message always survives, and is the LAST one.
    expect(req.messages[req.messages.length - 1].content).toBe('and finally, what now?')
  })
})

// AUDIT FIX (2026-08-24) — attachments are BOUND to a conversation.
//
// pendingFiles is component-level renderer state that no setActiveId site
// cleared, and the stored record carried no conversation id — so a file
// staged in client A's scoped conversation stayed in the composer when the
// user clicked client B's conversation in the rail, and was shipped verbatim
// into B's turn. In a client-scoped chat that is one client's document
// reaching another client's turn, under a system prompt that asserts the
// context holds only this client's records.
//
// Main could not catch it: readAttachmentRecord resolves any id against one
// shared attachments/ directory and loadAttachments validated only that the
// record EXISTED. There was no ownership to check. The renderer now prunes
// staged files by owner, and this is the backstop that makes every other path
// fail closed too.
describe('attachments are bound to their conversation', () => {
  it("a file staged in one conversation is REFUSED when sent from another", async () => {
    const { convId, invoke, inFlightCount } = await setup()
    const other = (await invoke('assistant:createConversation', undefined)) as { id: string }
    expect(other.id).not.toBe(convId)

    const added = (await invoke(
      'assistant:addAttachment',
      'AcmePricing.pdf',
      new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
      other.id
    )) as { ok: boolean; attachment: { id: string } }
    expect(added.ok).toBe(true)

    const result = (await invoke('assistant:send', convId, 'what does this say?', undefined, [
      added.attachment.id
    ])) as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(result.error).toBe('attachment-mismatch')
    expect(String(result.message)).toContain('AcmePricing.pdf')
    expect(
      streamControl.lastRequest,
      "another conversation's document reached the provider"
    ).toBeNull()
    expect(inFlightCount()).toBe(0)
  })

  it('an attachment with NO owner is refused too — fails closed, not open', async () => {
    // Records written before this field existed have no owner. Trusting them
    // would leave exactly the hole this closes, and staging happens seconds
    // before sending, so there is nothing real to preserve by being lenient.
    const { convId, invoke } = await setup()
    const added = (await invoke(
      'assistant:addAttachment',
      'legacy.txt',
      new TextEncoder().encode('older build').buffer,
      convId
    )) as { ok: boolean; attachment: { id: string } }

    // Strip the owner the way an older build would have left it.
    const recPath = join(convDir(), 'attachments', `${added.attachment.id}.json`)
    const rec = JSON.parse(await readFile(recPath, 'utf8')) as Record<string, unknown>
    delete rec.conversationId
    await writeFile(recPath, JSON.stringify(rec), 'utf8')

    const result = (await invoke('assistant:send', convId, 'read it', undefined, [
      added.attachment.id
    ])) as Record<string, unknown>
    expect(result.error).toBe('attachment-mismatch')
  })

  it('the normal case still works — same conversation, file goes through', async () => {
    const { convId, invoke } = await setup()
    const added = (await invoke(
      'assistant:addAttachment',
      'brief.txt',
      new TextEncoder().encode('Acme wants a pilot first.').buffer,
      convId
    )) as { ok: boolean; attachment: { id: string } }

    const pending = invoke('assistant:send', convId, 'summarise', undefined, [added.attachment.id])
    streamControl.push('Pilot first.')
    streamControl.end()
    const result = (await pending) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(streamControl.lastRequest).not.toBeNull()
  })
})

describe('M28 Part 3 — attachments + the vision gate', () => {
  it('an image with no vision-capable model is refused BEFORE the turn, naming the fix', async () => {
    const { convId, invoke, inFlightCount } = await setup()
    const added = (await invoke('assistant:addAttachment', 'shot.png', new Uint8Array([1, 2, 3]).buffer, convId)) as {
      ok: boolean
      attachment: { id: string }
    }
    expect(added.ok).toBe(true)
    chainMock.capable = 0 // keys configured, none can see
    const result = (await invoke('assistant:send', convId, 'what is in this?', undefined, [
      added.attachment.id
    ])) as Record<string, unknown>
    // AUDIT FIX (2026-08-24): assert what the gate ACTUALLY ASKED FOR, not
    // merely that it branched on a `capable` array someone handed it. The
    // mock recorded `needs` but nothing ever read it, so deleting
    // `{ needsVision: true }` from the production call — which in reality
    // resolves the ordinary chain and lets a BLIND model receive the image —
    // left every test in this area green.
    expect(chainMock.lastNeeds).toMatchObject({ needsVision: true })
    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain('read images')
    expect(streamControl.lastRequest).toBeNull() // never reached a provider
    expect(inFlightCount()).toBe(0)
  })

  // AUDIT FIX (2026-08-24) — there was NO PDF test anywhere in this file
  // (image and text only), and no document capability gate in the product.
  // A PDF rode ungated into the chain, openai-compatible.ts emitted an
  // OpenAI-only file part to providers that reject it, and each 400
  // blacklisted that model for four hours across every purpose — taking out
  // live call coaching from a chat window.
  it('a PDF with no document-capable model is refused BEFORE the turn, naming the fix', async () => {
    const { convId, invoke, inFlightCount } = await setup()
    const added = (await invoke(
      'assistant:addAttachment',
      'contract.pdf',
      new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
      convId
    )) as { ok: boolean; attachment: { id: string } }
    expect(added.ok).toBe(true)
    chainMock.capable = 0 // keys configured, none can read a document
    const result = (await invoke('assistant:send', convId, 'summarise this', undefined, [
      added.attachment.id
    ])) as Record<string, unknown>

    // The gate must ask for the DOCUMENT capability specifically. Asking for
    // vision would be a different question with a different answer: a model
    // can see an image and still reject a PDF (Groq's Llama 4 Scout is
    // exactly that), so reusing the vision flag here would let the PDF
    // through to a provider that 400s on it.
    expect(chainMock.lastNeeds).toMatchObject({ needsDocument: true })
    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain('PDF')
    expect(
      streamControl.lastRequest,
      'the PDF reached a provider — every rejection blacklists that model for 4h'
    ).toBeNull()
    expect(inFlightCount()).toBe(0)
  })

  it('with a vision-capable model the image rides the request and the metadata persists', async () => {
    const { convId, invoke } = await setup()
    const added = (await invoke('assistant:addAttachment', 'shot.png', new Uint8Array([9, 9]).buffer, convId)) as {
      ok: boolean
      attachment: { id: string }
    }
    const pending = invoke('assistant:send', convId, 'describe it', undefined, [added.attachment.id])
    streamControl.push('A chart.')
    streamControl.end()
    await pending
    const req = streamControl.lastRequest as { images?: unknown[]; messages: unknown[] }
    expect(req.images).toHaveLength(1)
    expect(req.messages).toHaveLength(1) // attachment turns bind to the current message only
    const conv = await getConversation(convDir(), convId)
    expect(conv?.messages[0].attachments?.[0]).toMatchObject({ name: 'shot.png', kind: 'image' })
  })

  it('a text document is injected as locally-extracted context, not sent as bytes', async () => {
    const { convId, invoke } = await setup()
    const added = (await invoke(
      'assistant:addAttachment',
      'brief.txt',
      new TextEncoder().encode('Acme wants a pilot before any annual commitment.').buffer,
      convId
    )) as { ok: boolean; attachment: { id: string; extractedChars: number } }
    expect(added.ok).toBe(true)
    const pending = invoke('assistant:send', convId, 'summarize the brief', undefined, [added.attachment.id])
    streamControl.push('Pilot first.')
    streamControl.end()
    await pending
    const req = streamControl.lastRequest as { system: string; images?: unknown[] }
    expect(req.system).toContain('ATTACHED FILE "brief.txt"')
    expect(req.system).toContain('Acme wants a pilot')
    expect(req.images).toBeUndefined()
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('assistant:send', () => {
  it('streams deltas, persists the complete turn with parsed citations, filters chips to memory', async () => {
    const { convId, invoke, inFlightCount } = await setup()
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
    expect(inFlightCount()).toBe(0)
  })

  // AUDIT FIX (2026-08-24) — the check-then-act race, made deterministic.
  //
  // The existing busy test below awaits the second invoke, which lets the
  // first turn's async prologue finish first — so it never exercised the
  // window. This one fires BOTH sends in the same tick, exactly like two
  // windows on one conversation or a double Enter inside one React batch.
  // With the old ordering (busy check after `await getConversation`,
  // registration after `await loadAttachments`) both calls observed an empty
  // map and both proceeded; the second registration overwrote the first, and
  // the first turn to settle deleted the survivor's slot — leaving cancel and
  // attach lying about a turn that was still streaming.
  it('two sends fired in the SAME TICK: exactly one wins, the other is told busy', async () => {
    const { convId, invoke, inFlightCount } = await setup()

    // No await between them — the claim must be atomic to survive this.
    const first = invoke('assistant:send', convId, 'one')
    const second = invoke('assistant:send', convId, 'two')
    const secondResult = (await second) as Record<string, unknown>

    expect(secondResult.ok, 'both sends were accepted — the slot claim is not atomic').toBe(false)
    expect(secondResult.error).toBe('busy')
    // Exactly one turn is registered, and it is the FIRST one — a later
    // registration overwriting the earlier entry is the corruption itself.
    expect(inFlightCount()).toBe(1)

    streamControl.push('winner')
    streamControl.end()
    const firstResult = (await first) as Record<string, unknown>
    expect(firstResult.ok).toBe(true)
    expect(firstResult.reply).toBe('winner')
    // Only the winning turn was persisted.
    const conv = await getConversation(convDir(), convId)
    expect(conv?.messages).toHaveLength(2)
    expect(conv?.messages[0].text).toBe('one')
    expect(inFlightCount()).toBe(0)
  })

  it('rejects a second send while one is in flight (busy), then frees the slot', async () => {
    const { convId, invoke, inFlightCount } = await setup()
    const first = invoke('assistant:send', convId, 'one')
    const second = (await invoke('assistant:send', convId, 'two')) as Record<string, unknown>
    expect(second.ok).toBe(false)
    expect(second.error).toBe('busy')
    streamControl.end()
    await first
    expect(inFlightCount()).toBe(0)
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

  // AUDIT FIX (2026-08-24) — the extraction id must belong to the USER's
  // message, asserted by ROLE rather than by position, across MORE THAN ONE
  // turn. The test above uses a first turn, where the old
  // `messages[length - 2]` arithmetic happens to equal index 0, so it could
  // not distinguish "the right message" from "the right offset".
  //
  // HONEST NOTE: this does not go red against the old code today. Behaviour
  // is identical while the tail of the array is always a complete
  // user+assistant pair, which appendTurn guarantees by appending both
  // atomically. What changed is that the caller no longer DEPENDS on that —
  // appendTurn now returns the id it minted. The failure this removes is
  // silent (a memory extracted from the user's words filed under the
  // assistant's id), so it is worth removing the dependency rather than
  // waiting for something to break it. See BUG-109.
  it('the extraction id is the latest USER message, across multiple turns', async () => {
    const { convId, invoke } = await setup()

    const first = invoke('assistant:send', convId, 'first question')
    streamControl.push('first answer')
    streamControl.end()
    await first

    memStore.extraction.mockClear()
    streamControl.reset()

    const second = invoke('assistant:send', convId, 'we use HubSpot for CRM')
    streamControl.push('Noted.')
    streamControl.end()
    await second

    expect(memStore.extraction).toHaveBeenCalledOnce()
    const [, gotMsgId] = memStore.extraction.mock.calls[0] as unknown as [string, string, string]

    const conv = await getConversation(convDir(), convId)
    const target = conv?.messages.find((m) => m.id === gotMsgId)
    expect(target, 'the extraction id matches no persisted message').toBeTruthy()
    expect(
      target?.role,
      "a memory extracted from the USER-side turn was filed under a non-user message"
    ).toBe('user')
    expect(target?.text).toBe('we use HubSpot for CRM')
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

/**
 * AUDIT FIX (2026-08-24) — replaces `await new Promise(r => setTimeout(r, 10))`
 * as the way these tests wait for a turn to reach a given state.
 *
 * A fixed 10ms sleep is a timeout standing in for a condition: it has to
 * cover loading the conversation, loading attachments, retrieval, planning,
 * building the context, starting the stream and consuming the first delta.
 * That fits comfortably when the file runs alone and does NOT fit under
 * full-suite CPU contention — which is precisely how it behaved: 30/30 twice
 * in isolation, one failure in the full run, with attach reporting
 * streaming:true and an empty accumulated string because the assertion
 * arrived before the first delta did.
 *
 * I have already mislabelled one load-dependent failure in this file as a
 * pre-existing flake; it was a real TOCTOU. So this one is fixed rather than
 * retried: the wait is now on the CONDITION, with a generous ceiling and a
 * failure message that names what never happened.
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting until ${what}`)
    }
    await new Promise((r) => setTimeout(r, 1))
  }
}

describe('stop and attach — the two M28 design claims', () => {
  it('cancel mid-stream keeps the partial reply as a persisted turn (stopped: true)', async () => {
    const { convId, invoke } = await setup()
    const pending = invoke('assistant:send', convId, 'long question')
    streamControl.push('Partial answer the user already read')
    // The delta must actually be consumed before aborting, or there is no
    // partial reply to keep and the test proves nothing.
    await waitUntil(() => streamControl.queue.length === 0, 'the pushed delta was consumed')
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
    await waitUntil(async () => {
      const probe = (await invoke('assistant:attach', convId)) as Record<string, unknown>
      return probe.streaming === true
    }, 'the turn was registered in flight')
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
    // Wait for the turn to have ACCUMULATED something rather than for a fixed
    // number of milliseconds. If it never does, waitUntil fails loudly — the
    // claim under test ("attach returns the text so far") is still what the
    // assertions below check, exactly, including the text itself.
    await waitUntil(async () => {
      const probe = (await invoke('assistant:attach', convId)) as Record<string, unknown>
      return probe.streaming === true && probe.accumulated !== ''
    }, 'attach reported a streaming turn with accumulated text')
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

    // Wait for PLANNING to have started, not merely for the turn to be
    // registered. Those were the same moment when this test was written and
    // are not any more: the busy-guard TOCTOU fix moved registration to the
    // first synchronous statement of handleSend, while planning still sits
    // behind an awaited retrieval.
    //
    // Waiting on the wrong one deadlocks rather than fails: releasePlan is
    // only assigned when the mock is CALLED, so cancelling before that point
    // fires the no-op default, and the hanging promise created moments later
    // has nobody left to resolve it. The old fixed 10ms sleep did not
    // guarantee this either — it just usually won the race, and would have
    // deadlocked the same way on a slow machine.
    await waitUntil(
      () => toolsMock.plan.mock.calls.length > 0,
      'planning was actually in flight (releasePlan is only bound once the mock is called)'
    )
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
    await waitUntil(() => streamControl.signal !== null, 'the engine passed an AbortSignal')
    expect(streamControl.signal?.aborted).toBe(false)
    await invoke('assistant:cancel', convId)
    expect(streamControl.signal?.aborted).toBe(true)
    await pending
  })
})
