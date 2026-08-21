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
type AssistantSendResult = Awaited<ReturnType<typeof window.api.assistant.send>>
type CoachChatContextSuggestion = AssistantSuggestion

export interface DisplayMessage extends AssistantMessage {
  streaming?: boolean
}

export interface UseAssistantChat {
  messages: DisplayMessage[]
  loading: boolean
  sending: boolean
  error: string | null
  /** "Don't learn from this conversation" state (fresh from the record). */
  learningExcluded: boolean
  setLearningExcluded: (excluded: boolean) => Promise<boolean>
  send: (text: string, voiceNote?: { mediaId: string; durationMs: number }) => Promise<void>
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

export function useAssistantChat(conversationId: string | null): UseAssistantChat {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [learningExcluded, setLearningExcludedState] = useState(false)
  const streamingIdRef = useRef<string | null>(null)
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
      }
      setLoading(false)
    })()

    const offDelta = window.api.assistant.onDelta((p) => {
      if (p.conversationId !== conversationId || !streamingIdRef.current) return
      setMessages((prev) =>
        prev.map((m) => (m.id === streamingIdRef.current ? { ...m, text: m.text + p.delta } : m))
      )
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
    }
  }, [conversationId, refetch])

  const send = useCallback(
    async (
      text: string,
      voiceNote?: { mediaId: string; durationMs: number }
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
        { id: userMsgId, role: 'user', text: trimmed, createdAt: new Date().toISOString() },
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
        result = await window.api.assistant.send(conversationId, trimmed, voiceNote)
      } catch {
        result = { ok: false, error: 'ai-failed', message: 'Something went wrong. Please try again.' }
      }
      ownsTurnRef.current = false
      if (!mountedRef.current) return
      streamingIdRef.current = null
      setSending(false)
      if (result.ok) {
        // Authoritative re-read keeps ids/persisted chips in perfect sync
        // (send already saved the turn — this is a local-disk read, cheap).
        await refetch()
      } else if (result.error === 'cancelled') {
        // Stopped before any token: drop the optimistic bubbles.
        setMessages((prev) => prev.filter((m) => m.id !== userMsgId && m.id !== streamingMsgId))
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== streamingMsgId))
        setError(result.message ?? 'Something went wrong.')
      }
    },
    [conversationId, sending, refetch]
  )

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
    send,
    stop,
    applySuggestion,
    confirmTask,
    clearError: useCallback(() => setError(null), [])
  }
}
