// M28 — IPC surface + turn engine for the Rise assistant. Streaming uses the
// app's one established shape (coaching-chat-ipc.ts): push events during the
// SAME invoke() that resolves with the final message. Two deliberate M28
// additions over that precedent, both answers to Phase 0 findings:
//
// 1. MAIN OWNS THE IN-FLIGHT TURN (the M26 principle — screens don't own
//    work). Deltas accumulate here, so a remounting renderer re-attaches via
//    assistant:attach and recovers the partial text instead of losing it to
//    navigation (the coaching chat's documented gap).
// 2. A REAL STOP. assistant:cancel aborts the walk through req.signal
//    (BUG-060's lesson: cancel must reach the actual work). A stop with
//    partial text persists the partial turn — already-streamed words the
//    user read are work product, not garbage (the BUG-048 lesson).
import { app, ipcMain, BrowserWindow } from 'electron'
import { AIProviderError } from '../ai'
import { streamWithFallback, AllModelsExhaustedError } from '../ai/complete-with-fallback'
import type { AIMessage } from '../ai/types'
import { businessProfileSection, repProfileSection } from '../memory/profile-injection'
import { retrieveRelevantMemoriesStructured } from '../memory/rag'
import { consolidateNewCandidate } from '../memory/consolidation'
import { getMemoryDb, ensureMemoryDb } from '../memory/memory-runtime'
import { getMemoryById } from '../memory/memories-store'
import { isSalesBrainEnabled } from '../app-settings'
import { extractContextSuggestions } from '../coaching-chat'
import type { CoachChatContextSuggestion } from '../calls-fs'
import type { MemoryCategory, MemoryScope } from '../memory/types'
import { buildAssistantContext, citationsUsedIn } from './context'
import {
  appendTurn,
  conversationsDir,
  createConversation,
  deleteConversation,
  getConversation,
  isSafeConversationId,
  listConversations,
  markSuggestionApplied,
  renameConversation,
  type AssistantCitation
} from './conversations-fs'

/** Replay window per turn — storage keeps up to MAX_MESSAGES (500), but the
 *  model re-reads only this many. Same split as the coaching chat's 40/300. */
const MAX_HISTORY_MESSAGES = 40
const MAX_INBOUND_CHARS = 8_000
const SUGGESTION_TIMEOUT_MS = 5_000
const MAX_TOKENS = 2_048

function dir(): string {
  return conversationsDir(app.getPath('userData'))
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof AllModelsExhaustedError) return err.message
  if (err instanceof AIProviderError) return err.message
  return 'Something went wrong. Please try again.'
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export interface AssistantSendResult {
  ok: boolean
  /** Machine-readable failure class; `message` is always the human copy. */
  error?: 'not-found' | 'busy' | 'empty' | 'ai-failed' | 'cancelled'
  message?: string
  reply?: string
  citations?: AssistantCitation[]
  suggestions?: CoachChatContextSuggestion[]
  /** True when the user stopped the stream and the partial reply was kept. */
  stopped?: boolean
  /** The persisted user-message id, so the renderer can wire suggestion chips
   *  to applySuggestion without re-fetching the conversation. */
  userMessageId?: string
}

export interface AssistantAttachSnapshot {
  streaming: boolean
  /** Accumulated text of the in-flight reply, '' when idle. */
  accumulated: string
  /** The user message that started the in-flight turn, for optimistic render. */
  pendingUserText: string
}

interface InFlightTurn {
  controller: AbortController
  accumulated: string
  userText: string
  /** Set by assistant:cancel so the finally-block knows a stop is a stop,
   *  not a provider failure. */
  stopRequested: boolean
}

const inFlight = new Map<string, InFlightTurn>()

/** Test seam: assert idle state without reaching into module internals. */
export function inFlightCountForTests(): number {
  return inFlight.size
}

async function handleSend(conversationId: string, rawMessage: string): Promise<AssistantSendResult> {
  const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, MAX_INBOUND_CHARS) : ''
  if (!isSafeConversationId(conversationId)) return { ok: false, error: 'not-found', message: 'Conversation not found.' }
  if (!message) return { ok: false, error: 'empty', message: 'Type a message first.' }
  const conv = await getConversation(dir(), conversationId)
  if (!conv) return { ok: false, error: 'not-found', message: 'Conversation not found.' }
  if (inFlight.has(conversationId)) {
    return { ok: false, error: 'busy', message: 'A reply is already in progress — stop it first.' }
  }

  // Foreground retrieval: ensureMemoryDb retry + bounded embedding, so a cold
  // start degrades to a memory-blind turn instead of a hung one. Hypotheses
  // included ON PURPOSE: a young install's Sales Brain is all hypotheses, and
  // "I don't know anything" next to a visibly full Memory Center is the
  // credibility trap Phase 0 flagged — context.ts hedges their phrasing.
  const retrieved = await retrieveRelevantMemoriesStructured(message, {
    foreground: true,
    includeHypotheses: true
  })
  const context = buildAssistantContext({
    repProfile: repProfileSection('full'),
    businessProfile: businessProfileSection('full'),
    retrieved
  })

  const history: AIMessage[] = conv.messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.text }))

  const turn: InFlightTurn = {
    controller: new AbortController(),
    accumulated: '',
    userText: message,
    stopRequested: false
  }
  inFlight.set(conversationId, turn)

  try {
    const stream = streamWithFallback({
      purpose: 'assistant-chat',
      system: context.system,
      messages: [...history, { role: 'user', content: message }],
      maxTokens: MAX_TOKENS,
      signal: turn.controller.signal
    })

    let streamError: unknown = null
    try {
      for await (const chunk of stream) {
        turn.accumulated += chunk.delta
        broadcast('assistant:delta', { conversationId, delta: chunk.delta })
      }
    } catch (err) {
      streamError = err
    }
    // Always settle .final — even on the error path — to avoid an unhandled
    // rejection (same rule coaching-chat-ipc.ts documents).
    await stream.final.catch(() => {})

    const stopped = turn.stopRequested
    if (streamError && !(stopped && turn.accumulated)) {
      if (stopped) {
        // Stopped before any token arrived — nothing worth keeping.
        return { ok: false, error: 'cancelled', message: 'Stopped.' }
      }
      const msg = friendlyError(streamError)
      broadcast('assistant:error', { conversationId, message: msg })
      return { ok: false, error: 'ai-failed', message: msg }
    }

    const reply = turn.accumulated
    const citations = citationsUsedIn(reply, context.citationsByMarker)

    // Save-chips: reuse the M23/M25 extraction on ONLY the user's message.
    // Global surface has no bound contact yet, so kyc/client-scope/call
    // suggestion types self-disable or are filtered — memory (rep/business)
    // is the one chip family that makes sense here in Phase 1.
    const suggestions = (
      await withTimeout(
        extractContextSuggestions(message, null).catch(() => []),
        SUGGESTION_TIMEOUT_MS,
        []
      )
    ).filter((s) => s.type === 'memory')

    const saved = await appendTurn(
      dir(),
      conversationId,
      { text: message, suggestions: suggestions.length > 0 ? suggestions : undefined },
      { text: reply, citations: citations.length > 0 ? citations : undefined }
    )
    const savedUser = saved?.messages[saved.messages.length - 2]

    return {
      ok: true,
      reply,
      citations,
      suggestions,
      stopped: stopped || undefined,
      userMessageId: savedUser?.id
    }
  } finally {
    inFlight.delete(conversationId)
  }
}

export function registerAssistant(): void {
  ipcMain.handle('assistant:listConversations', () => listConversations(dir()))

  ipcMain.handle('assistant:getConversation', (_e, id: unknown) =>
    typeof id === 'string' ? getConversation(dir(), id) : null
  )

  ipcMain.handle('assistant:createConversation', () => createConversation(dir()))

  ipcMain.handle('assistant:renameConversation', (_e, id: unknown, title: unknown) =>
    typeof id === 'string' && typeof title === 'string'
      ? renameConversation(dir(), id, title)
      : null
  )

  ipcMain.handle('assistant:deleteConversation', async (_e, id: unknown) => {
    if (typeof id !== 'string') return false
    // Deleting the conversation also aborts any in-flight turn for it —
    // otherwise the stream would finish into a file that no longer exists.
    const turn = inFlight.get(id)
    if (turn) {
      turn.stopRequested = true
      turn.controller.abort()
    }
    return deleteConversation(dir(), id)
  })

  ipcMain.handle('assistant:send', (_e, conversationId: unknown, message: unknown) =>
    handleSend(String(conversationId), String(message))
  )

  ipcMain.handle('assistant:cancel', (_e, conversationId: unknown) => {
    const turn = typeof conversationId === 'string' ? inFlight.get(conversationId) : undefined
    if (!turn) return false
    turn.stopRequested = true
    turn.controller.abort()
    return true
  })

  ipcMain.handle('assistant:attach', (_e, conversationId: unknown): AssistantAttachSnapshot => {
    const turn = typeof conversationId === 'string' ? inFlight.get(conversationId) : undefined
    return turn
      ? { streaming: true, accumulated: turn.accumulated, pendingUserText: turn.userText }
      : { streaming: false, accumulated: '', pendingUserText: '' }
  })

  ipcMain.handle(
    'assistant:applySuggestion',
    async (
      _e,
      conversationId: unknown,
      messageId: unknown,
      suggestion: CoachChatContextSuggestion
    ): Promise<{ ok: boolean }> => {
      try {
        if (typeof conversationId !== 'string' || typeof messageId !== 'string') return { ok: false }
        if (suggestion?.type !== 'memory') return { ok: false } // Phase 1: memory chips only on this surface
        if (!isSalesBrainEnabled() || !suggestion.memoryScope || !suggestion.memoryCategory) {
          return { ok: false }
        }
        // Foreground click — worth the ensureMemoryDb retry, unlike the
        // background hooks (memory-runtime.ts's own guidance).
        const db = getMemoryDb() ?? (await ensureMemoryDb()).db
        if (!db) return { ok: false }
        await consolidateNewCandidate(db, {
          scope: suggestion.memoryScope as MemoryScope,
          category: suggestion.memoryCategory as MemoryCategory,
          statement: suggestion.text,
          // Same synthetic-callId convention as onboarding ('onboarding:<topic>'):
          // the evidence traces to this conversation + message, not a call.
          evidence: [
            {
              type: 'transcript',
              callId: `assistant:${conversationId}`,
              chatMessageId: messageId,
              quote: suggestion.text
            }
          ],
          confidence: 0.95,
          importance: 6,
          source: 'user_stated'
        })
        await markSuggestionApplied(dir(), conversationId, messageId, suggestion.id)
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  )

  // Citation tap → the evidence behind a memory: statement, status,
  // confidence, and every verbatim quote with its source call id. Read-only.
  ipcMain.handle('assistant:getMemoryEvidence', (_e, memoryId: unknown) => {
    if (typeof memoryId !== 'string' || !isSalesBrainEnabled()) return null
    const db = getMemoryDb()
    if (!db) return null
    const memory = getMemoryById(db, memoryId)
    if (!memory) return null
    return {
      id: memory.id,
      statement: memory.statement,
      status: memory.status,
      confidence: memory.confidence,
      category: memory.category,
      scope: memory.scope,
      evidence: memory.evidence
    }
  })

}
