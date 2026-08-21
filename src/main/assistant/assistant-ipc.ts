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
import { join } from 'node:path'
import { AIProviderError } from '../ai'
import { streamWithFallback, AllModelsExhaustedError } from '../ai/complete-with-fallback'
import type { AIMessage } from '../ai/types'
import { businessProfileSection, repProfileSection } from '../memory/profile-injection'
import { retrieveRelevantMemoriesStructured } from '../memory/rag'
import { consolidateNewCandidate } from '../memory/consolidation'
import { getMemoryDb, ensureMemoryDb } from '../memory/memory-runtime'
import { deleteMemory, getMemoryById, listMemoriesByCallId } from '../memory/memories-store'
import { runMemoryExtractionForAssistantMessage } from '../memory/memory-hooks'
import { isSalesBrainEnabled } from '../app-settings'
import { extractContextSuggestions } from '../coaching-chat'
import type { CoachChatContextSuggestion } from '../calls-fs'
import type { MemoryCategory, MemoryScope } from '../memory/types'
import { buildAssistantContext, citationsUsedIn } from './context'
import {
  deleteVoiceNote,
  readVoiceNote,
  saveVoiceNote,
  transcribeVoiceNote,
  MAX_VOICE_NOTE_BYTES
} from './voice-note'
import { defaultToolDirs, executeLookups, planLookups, type TaskProposal } from './tools'
import { createTask } from '../tasks-fs'
import { scheduleBackup } from '../backup'
import {
  acceptTaskProposal,
  appendTurn,
  conversationsDir,
  createConversation,
  deleteConversation,
  getConversation,
  isSafeConversationId,
  listConversations,
  markSuggestionApplied,
  renameConversation,
  revertTaskProposal,
  setConversationSalesBrainExcluded,
  type AssistantCitation,
  type PersistedTaskProposal
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

function tasksDirPath(): string {
  return join(app.getPath('userData'), 'tasks')
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

async function handleSend(
  conversationId: string,
  rawMessage: string,
  voiceNote?: { mediaId: string; durationMs: number }
): Promise<AssistantSendResult> {
  const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, MAX_INBOUND_CHARS) : ''
  if (!isSafeConversationId(conversationId)) return { ok: false, error: 'not-found', message: 'Conversation not found.' }
  if (!message) return { ok: false, error: 'empty', message: 'Type a message first.' }
  const conv = await getConversation(dir(), conversationId)
  if (!conv) return { ok: false, error: 'not-found', message: 'Conversation not found.' }
  if (inFlight.has(conversationId)) {
    return { ok: false, error: 'busy', message: 'A reply is already in progress — stop it first.' }
  }

  // Audit fix V3 — the turn is registered (and therefore cancellable) BEFORE
  // the pre-stream phase: retrieval + planning + lookups can take many
  // seconds, and Stop must reach them, not only the token stream.
  const turn: InFlightTurn = {
    controller: new AbortController(),
    accumulated: '',
    userText: message,
    stopRequested: false
  }
  inFlight.set(conversationId, turn)

  try {
    // Foreground retrieval: ensureMemoryDb retry + bounded embedding, so a
    // cold start degrades to a memory-blind turn instead of a hung one.
    // Hypotheses included ON PURPOSE: a young install's Sales Brain is all
    // hypotheses, and "I don't know anything" next to a visibly full Memory
    // Center is the credibility trap Phase 0 flagged — context.ts hedges
    // their phrasing. Retrieval and lookup PLANNING run concurrently (both
    // need only the message); planning degrades to [] when no tool-capable
    // model exists.
    const [retrieved, planned] = await Promise.all([
      retrieveRelevantMemoriesStructured(message, {
        foreground: true,
        includeHypotheses: true
      }),
      planLookups(message, turn.controller.signal)
    ])
    if (turn.stopRequested) return { ok: false, error: 'cancelled', message: 'Stopped.' }
    const lookups = await executeLookups(
      planned,
      defaultToolDirs(app.getPath('userData')),
      turn.controller.signal
    )
    if (turn.stopRequested) return { ok: false, error: 'cancelled', message: 'Stopped.' }
    const context = buildAssistantContext({
      repProfile: repProfileSection('full'),
      businessProfile: businessProfileSection('full'),
      retrieved,
      lookupSections: lookups.sections
    })

    const history: AIMessage[] = conv.messages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.text }))

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
    if (!reply.trim()) {
      // A model can "succeed" with zero tokens; persisting that would write a
      // turn whose empty assistant message sanitize-on-read silently drops.
      const msg = 'The model returned an empty reply. Please try again.'
      broadcast('assistant:error', { conversationId, message: msg })
      return { ok: false, error: 'ai-failed', message: msg }
    }
    const citations = citationsUsedIn(reply, context.citationsByMarker)

    // Save-chips: reuse the M23/M25 extraction on ONLY the user's message.
    // Global surface has no bound contact yet, so kyc/client-scope/call
    // suggestion types self-disable or are filtered — memory (rep/business)
    // is the one chip family that makes sense here in Phase 1.
    // Audit fix V6: a chip that cannot possibly save (Sales Brain off, db
    // unavailable, or this conversation set to "Not learning") must never be
    // OFFERED — a clickable control that silently does nothing forever is
    // the failure mode. Skipping also saves the AI call.
    const suggestions = await (async () => {
      if (!isSalesBrainEnabled() || !getMemoryDb()) return []
      const freshConv = await getConversation(dir(), conversationId)
      if (!freshConv || freshConv.salesBrainExcluded) return []
      return (
        await withTimeout(
          extractContextSuggestions(message, null).catch(() => []),
          SUGGESTION_TIMEOUT_MS,
          []
        )
      ).filter((s) => s.type === 'memory')
    })()

    const taskProposals: PersistedTaskProposal[] = lookups.taskProposals.map((p: TaskProposal) => ({
      ...p,
      status: 'pending'
    }))
    const saved = await appendTurn(
      dir(),
      conversationId,
      {
        text: message,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        voiceNote
      },
      {
        text: reply,
        citations: citations.length > 0 ? citations : undefined,
        taskProposals: taskProposals.length > 0 ? taskProposals : undefined
      }
    )
    const savedUser = saved?.messages[saved.messages.length - 2]

    // M28 Phase 2 — the conversation feeds the Sales Brain like calls do.
    // Fire-and-forget (the coaching chat's exact precedent); the hook
    // re-reads BOTH permissions fresh (master flag + this conversation's
    // exclusion) at execution time, never from here.
    if (savedUser) {
      void runMemoryExtractionForAssistantMessage(conversationId, savedUser.id, message).catch(
        () => {}
      )
    }

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
    // Terminal signal for renderers that mounted mid-stream: THEIR invoke()
    // promise belongs to a dead component instance, so this broadcast is how
    // a recovered view learns the turn settled (it re-reads the conversation;
    // deltas alone can't distinguish "quiet" from "done"). Fired on every
    // outcome — success, stop, cancel, failure — after any persistence.
    broadcast('assistant:turnComplete', { conversationId })
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
    // Best-effort cleanup of the voice notes this conversation references —
    // read before delete, remove after, so a failed delete leaks nothing.
    const conv = await getConversation(dir(), id)
    const deleted = await deleteConversation(dir(), id)
    if (deleted && conv) {
      for (const m of conv.messages) {
        if (m.voiceNote) await deleteVoiceNote(dir(), m.voiceNote.mediaId)
      }
    }
    return deleted
  })

  ipcMain.handle(
    'assistant:send',
    (_e, conversationId: unknown, message: unknown, voiceNote: unknown) => {
      const vn = (voiceNote && typeof voiceNote === 'object' ? voiceNote : null) as {
        mediaId?: unknown
        durationMs?: unknown
      } | null
      return handleSend(
        String(conversationId),
        String(message),
        vn && typeof vn.mediaId === 'string' && typeof vn.durationMs === 'number'
          ? { mediaId: vn.mediaId, durationMs: vn.durationMs }
          : undefined
      )
    }
  )

  // --- M28 Phase 3: voice notes (record → transcribe → REVIEW → send) ------
  // Transcribe-and-store in one step; the renderer keeps its local blob, so
  // a failed transcription loses nothing (the user retries or types).
  // Nothing is attached to any message until the user actually sends.
  ipcMain.handle(
    'assistant:transcribeVoiceNote',
    async (
      _e,
      audio: unknown,
      mimeType: unknown,
      durationMs: unknown
    ): Promise<
      | { ok: true; text: string; mediaId: string; durationMs: number }
      | { ok: false; error: string; message: string }
    > => {
      if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0) {
        return { ok: false, error: 'empty', message: 'Nothing was recorded.' }
      }
      if (audio.byteLength > MAX_VOICE_NOTE_BYTES) {
        return { ok: false, error: 'too-large', message: 'That recording is too long.' }
      }
      const mime = mimeType === 'audio/ogg' ? 'audio/ogg' : 'audio/webm'
      const buffer = Buffer.from(audio)
      const result = await transcribeVoiceNote(buffer, mime)
      if (!result.ok || !result.text) {
        return {
          ok: false,
          error: result.error ?? 'api',
          message: result.message ?? 'Transcription failed.'
        }
      }
      const mediaId = await saveVoiceNote(dir(), buffer, mime === 'audio/ogg' ? 'ogg' : 'webm')
      const duration =
        typeof durationMs === 'number' && Number.isFinite(durationMs)
          ? Math.max(0, durationMs)
          : 0
      return { ok: true, text: result.text, mediaId, durationMs: duration }
    }
  )

  // Composer cancel after a successful transcription — the stored audio is
  // orphaned and should not linger.
  ipcMain.handle('assistant:discardVoiceNote', async (_e, mediaId: unknown) => {
    if (typeof mediaId === 'string') await deleteVoiceNote(dir(), mediaId)
    return true
  })

  // Playback: the renderer builds a blob URL from these bytes.
  ipcMain.handle('assistant:getVoiceNote', async (_e, mediaId: unknown) => {
    if (typeof mediaId !== 'string') return null
    const buffer = await readVoiceNote(dir(), mediaId)
    if (!buffer) return null
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

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

  // Confirm chip → the task is REALLY created (the only write this surface
  // performs besides memory chips, both user-confirmed). Accept-then-create:
  // acceptTaskProposal atomically claims the proposal under the conversation
  // lock (a double-click can't create twice); a create failure rolls it back.
  ipcMain.handle(
    'assistant:confirmTask',
    async (
      _e,
      conversationId: unknown,
      messageId: unknown,
      proposalId: unknown
    ): Promise<{ ok: boolean }> => {
      if (
        typeof conversationId !== 'string' ||
        typeof messageId !== 'string' ||
        typeof proposalId !== 'string'
      ) {
        return { ok: false }
      }
      const proposal = await acceptTaskProposal(dir(), conversationId, messageId, proposalId)
      if (!proposal) return { ok: false }
      try {
        await createTask(tasksDirPath(), {
          title: proposal.title,
          type: proposal.type,
          priority: proposal.priority,
          source: 'ai'
        })
        scheduleBackup()
        return { ok: true }
      } catch {
        await revertTaskProposal(dir(), conversationId, messageId, proposalId)
        return { ok: false }
      }
    }
  )

  // "Don't learn from this conversation" — mirrors the call-level exclusion
  // exactly (memory-center-ipc.ts's salesBrain:calls:setExcluded): setting it
  // ALSO retroactively deletes every memory this conversation taught, so
  // exclusion leaves zero trace. Turning it back off does not re-extract.
  ipcMain.handle(
    'assistant:setSalesBrainExcluded',
    async (
      _e,
      conversationId: unknown,
      excluded: unknown
    ): Promise<{ ok: boolean; message?: string }> => {
      if (typeof conversationId !== 'string' || typeof excluded !== 'boolean') return { ok: false }
      if (excluded) {
        // Audit fix (honesty): the pill's confirm promises "will be
        // forgotten" — if the memory store can't run the forget, FAIL CLOSED
        // (flag not set, error surfaced) rather than flipping the pill over
        // memories that quietly survive. Sales Brain OFF is fine: nothing
        // was ever stored, and extraction is master-gated anyway.
        const db = getMemoryDb() ?? (await ensureMemoryDb()).db
        if (isSalesBrainEnabled() && !db) {
          return {
            ok: false,
            message:
              'Sales Brain storage is unavailable, so what this conversation taught cannot be forgotten right now. Try again after restarting the app.'
          }
        }
        const conv = await setConversationSalesBrainExcluded(dir(), conversationId, true)
        if (!conv) return { ok: false }
        if (db) {
          for (const memory of listMemoriesByCallId(db, `assistant:${conversationId}`)) {
            deleteMemory(db, memory.id)
          }
        }
        return { ok: true }
      }
      const conv = await setConversationSalesBrainExcluded(dir(), conversationId, false)
      return { ok: conv !== null }
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
