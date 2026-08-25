// M23 Workstream B — IPC surface for the coaching chat (advisor + practice
// mode). Streaming is delivered as push events (coachChat:delta) during the
// SAME invoke() call that ultimately resolves with the final message —
// same shape as transcription.ts's emit() pattern, the only precedent for
// incremental main->renderer delivery in this app (see coach.ts's Phase 0
// research note: no streaming consumer existed anywhere before this).
import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  getCall,
  listCalls,
  appendCoachChatTurn,
  appendCallNotes,
  appendCommitment,
  speechSegments,
  type CoachChatMessage,
  type CoachChatMode,
  type CoachChatContextSuggestion
} from './calls-fs'
import { getContact, addComment } from './contacts-fs'
import { createTask } from './tasks-fs'
import { generatePostCallBrief } from './post-call-brief'
import { generateCrmNote } from './crm-notes'
import { applyKycField } from './kyc-apply'
import { AIProviderError, type AITool } from './ai'
import { completeWithFallback, streamWithFallback, AllModelsExhaustedError } from './ai/complete-with-fallback'
import { scheduleBackup } from './backup'
import { SKILL_LABEL } from './coaching/skill-graph'
import {
  assembleChatContext,
  buildAdvisorSystemPrompt,
  buildPracticeSystemPrompt,
  buildEndPracticeSystemPrompt,
  isEndPracticeMessage,
  extractContextSuggestions,
  callTranscript,
  type PastCallSummary,
  type TranscriptSection
} from './coaching-chat'
import {
  fitPromptToBudget,
  budgetCharsFor,
  DEFAULT_CONTEXT_WINDOW_TOKENS
} from './assistant/prompt-budget'
import { runMemoryExtractionForChatMessage } from './memory/memory-hooks'
import { businessProfileSection, clientProfileSection, repProfileSection } from './memory/profile-injection'
import { retrieveRelevantMemories } from './memory/rag'
import { consolidateNewCandidate } from './memory/consolidation'
import { getMemoryDb } from './memory/memory-runtime'
import { isSalesBrainEnabled } from './app-settings'
import type { MemoryCategory, MemoryScope } from './memory/types'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}
function tasksDir(): string {
  return join(app.getPath('userData'), 'tasks')
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function friendlyError(err: unknown): string {
  // BUG-057 Phase 3 — err.message is now summarizeExhaustion()'s classified
  // wait/add-key/bug message, not the old flat reason-code join this
  // hardcoded string used to compensate for.
  if (err instanceof AllModelsExhaustedError) return err.message
  if (err instanceof AIProviderError) return err.message
  return 'Something went wrong. Please try again.'
}

const MAX_PAST_CALLS = 5

async function loadPastCallSummaries(contactId: string | undefined, excludeCallId: string): Promise<PastCallSummary[]> {
  if (!contactId) return []
  const summaries = await listCalls(callsDir())
  const related = summaries
    .filter((s) => s.contactId === contactId && s.id !== excludeCallId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_PAST_CALLS)
  const out: PastCallSummary[] = []
  for (const s of related) {
    const full = await getCall(callsDir(), s.id)
    out.push({
      title: s.title,
      createdAt: s.createdAt,
      coachScore: s.coachScore,
      summary: full?.summary?.executive
    })
  }
  return out
}

/** The contiguous run of practice-mode messages at the END of the thread —
 *  "the current practice session", since advisor turns can come before or
 *  after any given practice session in the same call's thread. */
function trailingPracticeMessages(history: CoachChatMessage[]): CoachChatMessage[] {
  const tail: CoachChatMessage[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].mode !== 'practice') break
    tail.unshift(history[i])
  }
  return tail
}

export interface CoachChatSendResult {
  ok: boolean
  reply?: string
  suggestions?: CoachChatContextSuggestion[]
  error?: string
  message?: string
}

// A window, not the full stored thread — the system prompt already carries
// the full transcript/KYC/scorecard fresh every turn, so chat HISTORY only
// needs enough recent back-and-forth for conversational continuity. Without
// this, cost/latency/context-window usage grows unboundedly with a single
// long chat session (MAX_CHAT_MESSAGES=300 in calls-fs.ts only bounds what's
// stored, not what's replayed to the model on every turn).
const MAX_HISTORY_MESSAGES = 40

/** Best-effort with a hard time budget — extractContextSuggestions() is an
 *  ancillary pass; a slow/degraded provider chain must never hold up the
 *  chat turn the rep is actively waiting on past a few seconds. Whatever
 *  hasn't resolved by then is simply dropped (no suggestions that turn),
 *  never surfaced as an error. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms)
    })
  ])
}

async function handleSend(
  callId: string,
  rawMessage: string,
  mode: CoachChatMode,
  startFreshPractice: boolean
): Promise<CoachChatSendResult> {
  const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, 8_000) : ''
  if (!message) return { ok: false, error: 'failed', message: 'Type a message first.' }

  const call = await getCall(callsDir(), callId)
  if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
  if (!call.segments?.length) {
    return { ok: false, error: 'failed', message: 'This call has no transcript to chat about yet.' }
  }

  const contact = call.contactId ? await getContact(contactsDir(), call.contactId) : null
  const pastCalls = await loadPastCallSummaries(call.contactId, callId)
  // M25 Phase 4 — the FULL-size profile (rep + business + this client, if
  // linked — spec: "coaching chat... can afford the largest context") plus
  // a fresh retrieval pass keyed to THIS specific message, so an
  // open-ended question ("what do you know about how I sell?") surfaces
  // the most relevant memories, not just the generic always-included set.
  const salesBrainContext =
    `${repProfileSection('full')}${businessProfileSection('full')}${clientProfileSection(call.contactId ?? null, 'full')}` +
    (await retrieveRelevantMemories(message, call.contactId ?? null))
  const history = call.coachChat ?? []
  const endingPractice = mode === 'practice' && isEndPracticeMessage(message)

  // BUG-108 — the system prompt is built LAST, from a transcript the budget
  // below has already fitted. Each branch therefore records HOW to build its
  // system prompt rather than building it, and keeps the replayed history
  // separate from the turn's own message (the budget may drop history; it
  // must never touch the message).
  let buildSystem: (context: string) => string
  let historyForModel: { role: 'user' | 'assistant'; content: string }[]
  // '' for end-practice, whose feedback is about the roleplay that already
  // happened — that branch appends no new user turn, and the budget must
  // account for its absence rather than assume a trailing message.
  let trailingMessage: string
  // The ASSISTANT reply's own mode tag — 'advisor' both for normal advisor
  // replies and for end-practice feedback (the feedback itself is coaching,
  // not roleplay), 'practice' only for in-character buyer lines.
  let replyMode: CoachChatMode
  // The USER turn's own mode tag. 'end practice' itself gets tagged
  // 'advisor', NOT 'practice' — it and its coaching-feedback reply are a
  // matched advisor-mode pair (the exchange transitions OUT of roleplay).
  // Tagging it 'practice' (its literal trigger mode) while the reply is
  // 'advisor' used to leave an orphaned advisor-tagged assistant message
  // with no paired user turn once advisor history filtered practice turns
  // out — two consecutive assistant-role entries, which providers reject
  // outright as an invalid, non-alternating message sequence.
  let userMode: CoachChatMode

  if (endingPractice) {
    const focusSkill = call.coaching?.focusSkillAtCoaching
    buildSystem = (context) =>
      buildEndPracticeSystemPrompt(context, focusSkill ? SKILL_LABEL[focusSkill.skill] : null)
    const practiceTail = startFreshPractice ? [] : trailingPracticeMessages(history)
    historyForModel = practiceTail.map((m) => ({ role: m.role, content: m.text }))
    trailingMessage = ''
    replyMode = 'advisor'
    userMode = 'advisor'
  } else if (mode === 'practice') {
    buildSystem = buildPracticeSystemPrompt
    // startFreshPractice: the rep switched INTO practice mode again (even
    // within the same call) — never seed a new rehearsal attempt with a
    // PRIOR, unrelated practice session's lines just because nothing
    // formally "ended" the old one (the rep may have simply tabbed over to
    // Advisor to glance at the scorecard, then back).
    const practiceTail = startFreshPractice ? [] : trailingPracticeMessages(history)
    historyForModel = practiceTail
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.text }))
    trailingMessage = message
    replyMode = 'practice'
    userMode = 'practice'
  } else {
    buildSystem = buildAdvisorSystemPrompt
    const advisorHistory = history.filter((m) => m.mode !== 'practice')
    historyForModel = advisorHistory
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.text }))
    trailingMessage = message
    replyMode = 'advisor'
    userMode = 'advisor'
  }

  // BUG-108 — the TOTAL bound. Every input here was capped individually and
  // nothing capped the sum: 588,000 chars (~147,000 tokens at 4 chars/token)
  // was reachable against a declared 128,000-token window, because the entry
  // cap (8,000, :141) and the persistence cap (MAX_CHAT_TEXT 16,000) disagree
  // and the replay path enforces neither. Overflow returns a 400, which
  // failure-class.ts calls 'structural', and the walk then re-sends the SAME
  // oversize prompt to the next model, blacklisting each in turn for 4 hours
  // behind an AllModelsExhaustedError that never mentions size. On the
  // RELEASED build (v1.3.3) that break is keyed by catalogId alone, so it
  // takes down every AI feature, not just this one; cf053b9 purpose-scopes it
  // but is merged-and-unreleased. See prompt-budget.ts's header for both
  // numbers — do not quote just the main-branch one.
  //
  // Applied HERE, at assembly, for two reasons. It covers the
  // draftFollowUpEmail path (:419 persists an assistant turn from a different
  // generator, bounded only by MAX_CHAT_TEXT) because by this point that text
  // is simply history. And the transcript is only separately addressable
  // before the context parts are joined — afterwards the blob is opaque and
  // trimming its head would cut the role instructions, not the transcript.
  const transcript = callTranscript(call.segments)
  const assemble = (t: TranscriptSection): string =>
    buildSystem(assembleChatContext({ call, contact, pastCalls, salesBrainContext, transcript: t }))
  // The floor the budget may not cut: scorecard, KYC, past calls, notes,
  // Sales Brain, role instructions. Measured with an empty transcript but
  // truncated:true so the marker's own length is reserved unconditionally —
  // if the transcript turns out NOT to be truncated the real prompt is one
  // marker shorter than accounted for, i.e. under budget, never over.
  const systemFixed = assemble({ text: '', truncated: true })
  const budget = fitPromptToBudget(
    { systemFixed, trimmable: transcript.text, history: historyForModel, message: trailingMessage },
    budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS),
    // 'head' — give up the START of the call. callTranscript() keeps the END
    // for the same reason; both layers agree that recent speech is what a
    // coach is being asked about.
    'head'
  )
  const system = assemble({
    text: budget.trimmable,
    truncated: transcript.truncated || budget.trim.trimmableCharsDropped > 0
  })
  let messagesForModel: { role: 'user' | 'assistant'; content: string }[] = [
    ...budget.history,
    ...(trailingMessage ? [{ role: 'user' as const, content: trailingMessage }] : [])
  ]
  if (messagesForModel.length === 0) {
    messagesForModel = [{ role: 'user', content: '(No practice turns were recorded — just acknowledge that briefly and encourage them to try practice mode again.)' }]
  }
  if (budget.trim.trimmed) {
    console.warn(
      '[coaching-chat] prompt trimmed to fit the context budget:',
      `${budget.trim.historyMessagesDropped} history message(s) dropped, ` +
        `${budget.trim.trimmableCharsDropped} transcript char(s) omitted`
    )
  }
  // The guard in fitPromptToBudget REPAIRS a history that begins on an
  // assistant turn, which is right for a live call — but a silent repair also
  // makes the underlying breakage undetectable. Four consumers depend on the
  // user/assistant pairing invariant and none enforce it, so if it ever does
  // break (an odd cap, a single unpaired append, a new consumer) this line is
  // the only evidence anyone would get. Try-wrapped and last, so an
  // observation can never alter the turn it is observing.
  try {
    if (budget.historyStartedOnAssistant) {
      console.warn(
        '[coaching-chat] coachChat history for call',
        callId,
        'began on an assistant turn — the user/assistant pairing invariant is broken upstream.',
        'The prompt was repaired for this turn; the cause has NOT been fixed.'
      )
    }
  } catch {
    // An observation must never break a live coaching turn.
  }
  if (!budget.fits) {
    // The fixed floor alone exceeds the budget — nothing the bound is allowed
    // to cut can fix it. Logged rather than hidden behind a result that looks
    // fitted; the request still goes out, because a degraded answer beats
    // refusing a turn the rep is waiting on mid-call.
    console.warn('[coaching-chat] prompt still exceeds the budget after trimming — fixed context alone is too large')
  }

  const stream = streamWithFallback({
    purpose: 'coaching-chat',
    system,
    maxTokens: 2048,
    messages: messagesForModel
  })

  let full = ''
  let streamError: unknown = null
  try {
    for await (const chunk of stream) {
      full += chunk.delta
      broadcast('coachChat:delta', { callId, delta: chunk.delta })
    }
  } catch (err) {
    streamError = err
  }
  // ALWAYS settle `final`, on both the success and failure path — it
  // rejects with the exact same error the loop above already threw (see
  // streamWithFallback's contract), and leaving a rejected promise with no
  // handler attached fires Node's unhandledRejection on every stream
  // failure, miscategorizing an already-handled chat error as a crash in
  // the support-facing log.
  try {
    await stream.final
  } catch (err) {
    streamError = streamError ?? err
  }
  if (streamError) {
    const msg = friendlyError(streamError)
    broadcast('coachChat:error', { callId, message: msg })
    return { ok: false, error: 'failed', message: msg }
  }

  if (!full.trim()) {
    return { ok: false, error: 'failed', message: 'The coach came back with an empty reply. Please try again.' }
  }

  const saved = await appendCoachChatTurn(
    callsDir(),
    callId,
    { text: message, mode: userMode },
    { text: full, mode: replyMode }
  )
  if (!saved) {
    return { ok: false, error: 'failed', message: 'The reply came through but could not be saved. Please retry.' }
  }

  // Context-save suggestions only make sense for real advisor-mode input —
  // never for in-character roleplay lines or the end-practice control
  // phrase — and must never hold up the turn the rep is waiting on.
  const suggestions =
    mode === 'advisor' && !endingPractice
      ? await withTimeout(extractContextSuggestions(message, call.contactId ?? null), 5_000, [])
      : []

  // M25 — per-message extraction (not awaited, unlike suggestions above:
  // there's no chip UI consuming this yet in Phase 1, and it must never add
  // latency to a reply the rep is actively waiting on). Same restriction as
  // the KYC suggestions above: only real advisor-mode input from the rep,
  // never in-character roleplay lines (those are a fictional buyer persona
  // talking, not the rep — extracting "facts" from them would be exactly
  // the kind of thing this feature must never do) and never the end-
  // practice control phrase itself.
  if (mode === 'advisor' && !endingPractice) {
    // BUG-110 (hardening) — this was `saved.coachChat[length - 2]?.id`,
    // inferring the rep's message by position. Correct only while the tail is
    // a complete user+assistant pair, which nothing enforces; landing one off
    // would file a memory extracted from the REP's words under the coach's
    // id, silently and with no error. appendCoachChatTurn now returns the id
    // it minted, so there is no inference left to get wrong.
    void runMemoryExtractionForChatMessage(callId, saved.userMessageId, message).catch(() => {})
  }

  return { ok: true, reply: full, suggestions }
}

interface TaskProposal {
  title: string
  type: 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
  priority: 'low' | 'medium' | 'high'
}

const TASK_TYPES = new Set(['follow-up', 'email', 'meeting', 'research', 'general'])
const TASK_PRIORITIES = new Set(['low', 'medium', 'high'])

const PROPOSE_TASK_TOOL: AITool = {
  name: 'propose_task',
  description: 'Propose exactly one concrete follow-up task from this call.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, concrete, actionable task title.' },
      type: { type: 'string', enum: ['follow-up', 'email', 'meeting', 'research', 'general'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] }
    },
    required: ['title', 'type', 'priority'],
    additionalProperties: false
  }
}

let registered = false

export function registerCoachingChat(): void {
  if (registered) return
  registered = true

  ipcMain.handle(
    'coachChat:send',
    async (
      _e,
      callId: string,
      message: string,
      mode: CoachChatMode,
      startFreshPractice?: boolean
    ): Promise<CoachChatSendResult> => {
      try {
        return await handleSend(callId, message, mode === 'practice' ? 'practice' : 'advisor', !!startFreshPractice)
      } catch {
        return { ok: false, error: 'failed', message: 'Something went wrong. Please try again.' }
      }
    }
  )

  ipcMain.handle(
    'coachChat:applySuggestion',
    async (_e, callId: string, suggestion: CoachChatContextSuggestion): Promise<{ ok: boolean }> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false }

        if (suggestion.type === 'kyc') {
          if (!call.contactId || !suggestion.field) return { ok: false }
          // Shared with Workstream C's standalone KYC-harvest chips — same
          // allowed-field check and dealValue parsing/rejection either way.
          // Note: this is a small, deliberate behavior IMPROVEMENT over the
          // pre-refactor inline code for dealValue specifically — that code
          // passed unparseable text straight to updateContact(), where
          // sanitizeValue() silently coerced it to undefined (wiping any
          // existing dealValue) while still reporting ok:true. applyKycField()
          // rejects up front instead, leaving the existing value untouched.
          const contact = await applyKycField(contactsDir(), call.contactId, suggestion.field, suggestion.text)
          if (contact) scheduleBackup()
          return { ok: !!contact }
        }

        if (suggestion.type === 'call-notes') {
          const updated = await appendCallNotes(callsDir(), callId, suggestion.text)
          return { ok: !!updated }
        }

        if (suggestion.type === 'next-steps') {
          // appendCommitment() reads the current call INSIDE its own lock and
          // merges — not a read-outside-lock-then-overwrite via
          // setCallCommitments(), which would lose a concurrently-applied
          // commitment if two suggestion chips are clicked in quick succession.
          const updated = await appendCommitment(callsDir(), callId, { owner: 'rep', text: suggestion.text })
          return { ok: !!updated }
        }

        if (suggestion.type === 'memory') {
          // M25 Phase 4 — "Save to Sales Brain" chip. source: 'user_stated'
          // (not 'auto'): a rep explicitly clicking Save on their own
          // message IS direct confirmation — this starts 'active'
          // immediately (memories-store.ts's initialStatus()), skipping
          // the 3-call promotion hypotheses go through, the same way a
          // manual KYC edit is trusted immediately.
          if (!isSalesBrainEnabled() || !suggestion.memoryScope || !suggestion.memoryCategory) return { ok: false }
          const db = getMemoryDb()
          if (!db) return { ok: false }
          await consolidateNewCandidate(db, {
            scope: suggestion.memoryScope as MemoryScope,
            category: suggestion.memoryCategory as MemoryCategory,
            statement: suggestion.text,
            evidence: [{ type: 'transcript', callId, quote: suggestion.text }],
            confidence: 0.95,
            importance: 6,
            source: 'user_stated'
          })
          return { ok: true }
        }

        return { ok: false }
      } catch {
        return { ok: false }
      }
    }
  )

  // --- Actions: draft follow-up email, propose+confirm a task, regenerate the CRM note ---

  ipcMain.handle('coachChat:draftFollowUpEmail', async (_e, callId: string): Promise<CoachChatSendResult> => {
    try {
      const call = await getCall(callsDir(), callId)
      if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
      const result = await generatePostCallBrief(speechSegments(call.segments), call.title)
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          message:
            result.error === 'empty-call'
              ? 'This call is too short to draft a follow-up from.'
              : (result.message ?? 'Could not draft a follow-up email.')
        }
      }
      const text = `Subject: ${result.brief.email.subject}\n\n${result.brief.email.body}`
      const saved = await appendCoachChatTurn(
        callsDir(),
        callId,
        { text: 'Draft a follow-up email for this call.', mode: 'advisor' },
        { text, mode: 'advisor' }
      )
      if (!saved) return { ok: false, error: 'failed', message: 'Could not save the draft.' }
      return { ok: true, reply: text }
    } catch {
      return { ok: false, error: 'failed', message: 'Could not draft a follow-up email.' }
    }
  })

  ipcMain.handle(
    'coachChat:proposeTask',
    async (_e, callId: string): Promise<{ ok: true; proposal: TaskProposal } | { ok: false; message: string }> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, message: 'Call not found.' }
        const contact = call.contactId ? await getContact(contactsDir(), call.contactId) : null
        const context = assembleChatContext({
          call,
          contact,
          pastCalls: await loadPastCallSummaries(call.contactId, callId)
        })
        const result = await completeWithFallback({
          purpose: 'coaching-chat',
          maxTokens: 300,
          tool: PROPOSE_TASK_TOOL,
          messages: [
            {
              role: 'user',
              content: `Propose ONE concrete follow-up task from this call.\n\n${context}`
            }
          ]
        })
        const raw = result.toolInput ?? {}
        const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 300) : ''
        if (!title) return { ok: false, message: 'Could not come up with a task for this call.' }
        const type = TASK_TYPES.has(raw.type as string) ? (raw.type as TaskProposal['type']) : 'general'
        const priority = TASK_PRIORITIES.has(raw.priority as string)
          ? (raw.priority as TaskProposal['priority'])
          : 'medium'
        return { ok: true, proposal: { title, type, priority } }
      } catch {
        return { ok: false, message: 'Could not come up with a task for this call.' }
      }
    }
  )

  ipcMain.handle(
    'coachChat:confirmTask',
    async (_e, callId: string, proposal: TaskProposal): Promise<{ ok: boolean }> => {
      try {
        if (!proposal?.title) return { ok: false }
        const call = await getCall(callsDir(), callId)
        const task = await createTask(tasksDir(), {
          title: proposal.title,
          type: TASK_TYPES.has(proposal.type) ? proposal.type : 'general',
          priority: TASK_PRIORITIES.has(proposal.priority) ? proposal.priority : 'medium',
          source: 'ai',
          callId,
          callTitle: call?.title,
          contactId: call?.contactId
        })
        scheduleBackup()
        return { ok: !!task }
      } catch {
        return { ok: false }
      }
    }
  )

  ipcMain.handle(
    'coachChat:regenerateCrmNote',
    async (_e, callId: string): Promise<{ ok: true; note: string } | { ok: false; message: string }> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, message: 'Call not found.' }
        if (!call.contactId) {
          return { ok: false, message: 'This call has no linked contact yet — link one first.' }
        }
        const chatContext = (call.coachChat ?? [])
          .filter((m) => m.mode !== 'practice')
          .map((m) => `${m.role === 'user' ? 'Rep' : 'Coach'}: ${m.text}`)
          .join('\n')
        const source =
          [call.summary?.executive, call.notes, chatContext].filter(Boolean).join('\n\n') ||
          speechSegments(call.segments)
            .map((s) => `Speaker ${s.speaker + 1}: ${s.text}`)
            .join('\n')
        const result = await generateCrmNote(source)
        if (!result.ok) return { ok: false, message: 'Could not draft a note. Please try again.' }
        return { ok: true, note: result.note }
      } catch {
        return { ok: false, message: 'Could not draft a note. Please try again.' }
      }
    }
  )

  ipcMain.handle(
    'coachChat:saveCrmNote',
    async (_e, callId: string, note: string): Promise<{ ok: boolean }> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call?.contactId) return { ok: false }
        const text = typeof note === 'string' ? note.trim() : ''
        if (!text) return { ok: false }
        const contact = await addComment(contactsDir(), call.contactId, text, 'ai')
        if (contact) scheduleBackup()
        return { ok: !!contact }
      } catch {
        return { ok: false }
      }
    }
  )
}
