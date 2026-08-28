// M28 — streaming chat state for one Rise conversation. Same delta-during-
// invoke shape as useCoachChat, plus the M28 recovery contract: MAIN owns the
// in-flight turn, so on mount this hook calls attach() — if a turn is already
// streaming (started before a navigation unmounted the previous instance) it
// rebuilds the optimistic bubbles from the snapshot and keeps consuming
// deltas. assistant:turnComplete is the terminal signal for exactly that
// recovered case, where the original invoke() promise died with the old
// component instance.
import { useCallback, useEffect, useRef, useState } from 'react'

// House convention (see ModelAssignmentSection.tsx): renderer types derive
// from the preload bridge itself, so they can never drift from what IPC
// actually returns.
export type AssistantConversation = NonNullable<
  Awaited<ReturnType<typeof window.api.assistant.getConversation>>
>
export type AssistantMessage = AssistantConversation['messages'][number]
export type AssistantCitation = NonNullable<AssistantMessage['citations']>[number]
export type AssistantSuggestion = NonNullable<AssistantMessage['suggestions']>[number]
export type AssistantAttachment = NonNullable<AssistantMessage['attachments']>[number]
export type AssistantScope = NonNullable<AssistantConversation['scope']>
type AssistantSendResult = Awaited<ReturnType<typeof window.api.assistant.send>>
type CoachChatContextSuggestion = AssistantSuggestion

export interface DisplayMessage extends AssistantMessage {
  streaming?: boolean
}

export interface AssistantChatOptions {
  /** Audit fix V2 (blank first turn): a message to send automatically,
   *  exactly once, when this conversation loads EMPTY. The new-conversation
   *  path hands the first message here instead of fire-and-forgetting a raw
   *  IPC send, so the first turn goes through the SAME optimistic-bubble +
   *  delta-streaming machinery as every other send. */
  initialMessage?: {
    text: string
    voiceNote?: { mediaId: string; durationMs: number }
    attachments?: AssistantAttachment[]
  }
}

export interface UseAssistantChat {
  messages: DisplayMessage[]
  loading: boolean
  sending: boolean
  error: string | null
  /** "Don't learn from this conversation" state (fresh from the record). */
  learningExcluded: boolean
  setLearningExcluded: (excluded: boolean) => Promise<boolean>
  /** Pre-first-token activity ('reading' | 'searching' | 'thinking'), null
   *  once tokens flow or the turn settles. */
  phase: 'reading' | 'searching' | 'thinking' | null
  send: (
    text: string,
    voiceNote?: { mediaId: string; durationMs: number },
    attachments?: AssistantAttachment[]
  ) => Promise<void>
  /** The conversation's client scope (M28 Part 4), fresh from the record. */
  scope: AssistantScope | null
  stop: () => Promise<void>
  applySuggestion: (
    messageId: string,
    suggestion: CoachChatContextSuggestion
  ) => Promise<boolean>
  confirmTask: (messageId: string, proposalId: string) => Promise<boolean>
  clearError: () => void
}

let localId = 0
function nextLocalId(): string {
  localId += 1
  return `local-${localId}`
}

export function useAssistantChat(
  conversationId: string | null,
  options?: AssistantChatOptions
): UseAssistantChat {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [learningExcluded, setLearningExcludedState] = useState(false)
  const [phase, setPhase] = useState<'reading' | 'searching' | 'thinking' | null>(null)
  const [scope, setScope] = useState<AssistantScope | null>(null)
  const streamingIdRef = useRef<string | null>(null)
  // Read through refs inside the load effect so a new options object per
  // render never re-runs it; the consumed set makes the initial send
  // exactly-once per conversation even across remounts.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const initialSendConsumedRef = useRef(new Set<string>())
  const sendRef = useRef<UseAssistantChat['send']>(async () => {})
  // True while THIS instance's send() invoke is pending — its resolution
  // handles the final state, so turnComplete is ignored. False for a
  // recovered stream, where turnComplete triggers the authoritative re-read.
  const ownsTurnRef = useRef(false)
  const mountedRef = useRef(true)

  const refetch = useCallback(async (): Promise<void> => {
    if (!conversationId) return
    const conv = await window.api.assistant.getConversation(conversationId)
    if (!mountedRef.current) return
    streamingIdRef.current = null
    setSending(false)
    setMessages(conv?.messages ?? [])
    setLearningExcludedState(conv?.salesBrainExcluded === true)
    setScope(conv?.scope ?? null)
  }, [conversationId])

  useEffect(() => {
    mountedRef.current = true
    streamingIdRef.current = null
    ownsTurnRef.current = false
    setMessages([])
    setError(null)
    setSending(false)
    if (!conversationId) return undefined

    setLoading(true)
    void (async () => {
      const [conv, snapshot] = await Promise.all([
        window.api.assistant.getConversation(conversationId),
        window.api.assistant.attach(conversationId)
      ])
      if (!mountedRef.current) return
      setLearningExcludedState(conv?.salesBrainExcluded === true)
      setScope(conv?.scope ?? null)
      const base: DisplayMessage[] = conv?.messages ?? []
      if (snapshot.streaming) {
        // Recover the in-flight turn: rebuild the two live bubbles from
        // main's snapshot and keep streaming into them.
        const streamingMsgId = nextLocalId()
        streamingIdRef.current = streamingMsgId
        setSending(true)
        setMessages([
          ...base,
          {
            id: nextLocalId(),
            role: 'user',
            text: snapshot.pendingUserText,
            createdAt: new Date().toISOString()
          },
          {
            id: streamingMsgId,
            role: 'assistant',
            text: snapshot.accumulated,
            createdAt: new Date().toISOString(),
            streaming: true
          }
        ])
      } else {
        setMessages(base)
        // The new-conversation first message: fires only for a genuinely
        // empty, idle conversation, exactly once (audit fix V2).
        const initial = optionsRef.current?.initialMessage
        if (initial && base.length === 0 && !initialSendConsumedRef.current.has(conversationId)) {
          initialSendConsumedRef.current.add(conversationId)
          void sendRef.current(initial.text, initial.voiceNote, initial.attachments)
        }
      }
      setLoading(false)
    })()

    const offDelta = window.api.assistant.onDelta((p) => {
      if (p.conversationId !== conversationId || !streamingIdRef.current) return
      setPhase(null) // tokens are flowing — the activity line yields to text
      setMessages((prev) =>
        prev.map((m) => (m.id === streamingIdRef.current ? { ...m, text: m.text + p.delta } : m))
      )
    })
    const offPhase = window.api.assistant.onPhase((p) => {
      if (p.conversationId !== conversationId) return
      setPhase(p.phase)
    })
    const offError = window.api.assistant.onError((p) => {
      if (p.conversationId !== conversationId) return
      setError(p.message)
    })
    const offComplete = window.api.assistant.onTurnComplete((p) => {
      if (p.conversationId !== conversationId || ownsTurnRef.current) return
      // A recovered (or foreign-window) turn settled — re-read the truth.
      void refetch()
    })
    return () => {
      mountedRef.current = false
      offDelta()
      offError()
      offComplete()
      offPhase()
    }
  }, [conversationId, refetch])

  const send = useCallback(
    async (
      text: string,
      voiceNote?: { mediaId: string; durationMs: number },
      attachments?: AssistantAttachment[]
    ): Promise<void> => {
      const trimmed = text.trim()
      if (!conversationId || !trimmed || sending) return
      setError(null)
      setSending(true)
      ownsTurnRef.current = true
      const userMsgId = nextLocalId()
      const streamingMsgId = nextLocalId()
      streamingIdRef.current = streamingMsgId
      setMessages((prev) => [
        ...prev,
        {
          id: userMsgId,
          role: 'user',
          text: trimmed,
          createdAt: new Date().toISOString(),
          attachments: attachments && attachments.length > 0 ? attachments : undefined
        },
        {
          id: streamingMsgId,
          role: 'assistant',
          text: '',
          createdAt: new Date().toISOString(),
          streaming: true
        }
      ])
      let result: AssistantSendResult
      try {
        result = await window.api.assistant.send(
          conversationId,
          trimmed,
          voiceNote,
          attachments?.map((a) => a.id)
        )
      } catch {
        result = { ok: false, error: 'ai-failed', message: 'Something went wrong. Please try again.' }
      }
      ownsTurnRef.current = false
      if (!mountedRef.current) return
      streamingIdRef.current = null
      setSending(false)
      setPhase(null)
      if (result.ok) {
        // Authoritative re-read keeps ids/persisted chips in perfect sync
        // (send already saved the turn — this is a local-disk read, cheap).
        await refetch()
      } else {
        // No turn was persisted, so an attached voice note's media file is
        // now unreferenced — clean it up instead of leaking it (audit).
        if (voiceNote) void window.api.assistant.discardVoiceNote(voiceNote.mediaId)
        for (const a of attachments ?? []) void window.api.assistant.discardAttachment(a.id)
        if (result.error === 'cancelled') {
          // Stopped before any token: drop the optimistic bubbles.
          setMessages((prev) => prev.filter((m) => m.id !== userMsgId && m.id !== streamingMsgId))
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== streamingMsgId))
          setError(result.message ?? 'Something went wrong.')
        }
      }
    },
    [conversationId, sending, refetch]
  )
  sendRef.current = send

  const stop = useCallback(async (): Promise<void> => {
    if (!conversationId) return
    await window.api.assistant.cancel(conversationId)
  }, [conversationId])

  const applySuggestion = useCallback(
    async (messageId: string, suggestion: CoachChatContextSuggestion): Promise<boolean> => {
      if (!conversationId) return false
      const res = await window.api.assistant.applySuggestion(conversationId, messageId, suggestion)
      if (res.ok && mountedRef.current) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  appliedSuggestionIds: [...new Set([...(m.appliedSuggestionIds ?? []), suggestion.id])]
                }
              : m
          )
        )
      }
      return res.ok
    },
    [conversationId]
  )

  const confirmTask = useCallback(
    async (messageId: string, proposalId: string): Promise<boolean> => {
      if (!conversationId) return false
      const res = await window.api.assistant.confirmTask(conversationId, messageId, proposalId)
      if (res.ok && mountedRef.current) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  taskProposals: m.taskProposals?.map((p) =>
                    p.id === proposalId ? { ...p, status: 'accepted' as const } : p
                  )
                }
              : m
          )
        )
      }
      return res.ok
    },
    [conversationId]
  )

  const setLearningExcluded = useCallback(
    async (excluded: boolean): Promise<boolean> => {
      if (!conversationId) return false
      const res = await window.api.assistant.setSalesBrainExcluded(conversationId, excluded)
      if (res.ok && mountedRef.current) setLearningExcludedState(excluded)
      return res.ok
    },
    [conversationId]
  )

  return {
    messages,
    loading,
    sending,
    error,
    learningExcluded,
    setLearningExcluded,
    phase,
    scope,
    send,
    stop,
    applySuggestion,
    confirmTask,
    clearError: useCallback(() => setError(null), [])
  }
}
