import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CoachChatContextSuggestion,
  CoachChatMessage,
  CoachChatMode,
  CoachChatTaskProposal
} from './types'

export interface DisplayMessage extends CoachChatMessage {
  /** True only for the in-progress assistant bubble while deltas are still
   *  arriving — cleared the moment coachChat:send resolves. */
  streaming?: boolean
  /** Attached once the turn completes — only ever set on a 'user' message
   *  (the suggestions are ABOUT what the rep just said). */
  suggestions?: CoachChatContextSuggestion[]
  /** Suggestion ids the rep has already applied, so the chip shows a
   *  checkmark instead of staying clickable forever. */
  appliedSuggestionIds?: string[]
}

export interface UseCoachChat {
  messages: DisplayMessage[]
  mode: CoachChatMode
  setMode: (m: CoachChatMode) => void
  sending: boolean
  error: string | null
  send: (text: string) => Promise<void>
  endPractice: () => Promise<void>
  applySuggestion: (messageId: string, suggestion: CoachChatContextSuggestion) => Promise<boolean>
  draftFollowUpEmail: () => Promise<void>
  proposeTask: () => Promise<CoachChatTaskProposal | null>
  confirmTask: (proposal: CoachChatTaskProposal) => Promise<boolean>
  regenerateCrmNote: () => Promise<string | null>
  saveCrmNote: (note: string) => Promise<boolean>
}

let localIdCounter = 0
function localId(): string {
  localIdCounter += 1
  return `local-${localIdCounter}`
}

/** M23 Workstream B — chat state + the streaming consumption loop. The
 *  `coachChat.send` invoke() call resolves with the FINAL message once the
 *  whole reply has arrived; onDelta events (subscribed before every send)
 *  fill the in-progress bubble in the meantime — Electron IPC has no native
 *  stream, so this push-during-an-in-flight-invoke shape is how every
 *  streaming feature in this app will have to work. */
export function useCoachChat(callId: string, initialMessages: CoachChatMessage[]): UseCoachChat {
  const [messages, setMessages] = useState<DisplayMessage[]>(initialMessages)
  const [mode, setModeState] = useState<CoachChatMode>('advisor')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const streamingIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  // True from the moment the rep switches INTO practice mode until their
  // first send in that mode — tells the backend to ignore any trailing
  // practice turns left over from an earlier session that was never
  // formally closed with "End practice" (e.g. the rep tabbed to Advisor
  // mid-rehearsal and later came back to Practice).
  const freshPracticeRef = useRef(false)

  const setMode = useCallback((m: CoachChatMode) => {
    if (m === 'practice') freshPracticeRef.current = true
    setModeState(m)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const offDelta = window.api.coachChat.onDelta((payload) => {
      const p = payload as { callId: string; delta: string }
      if (p.callId !== callId) return
      const id = streamingIdRef.current
      if (!id || !mountedRef.current) return
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + p.delta } : m)))
    })
    const offError = window.api.coachChat.onError((payload) => {
      const p = payload as { callId: string; message: string }
      if (p.callId !== callId || !mountedRef.current) return
      setError(p.message)
    })
    return () => {
      offDelta()
      offError()
    }
  }, [callId])

  const send = useCallback(
    async (text: string, sendMode: CoachChatMode = mode): Promise<void> => {
      const trimmed = text.trim()
      if (!trimmed || sending) return
      setError(null)
      setSending(true)

      const userMsg: DisplayMessage = {
        id: localId(),
        role: 'user',
        text: trimmed,
        createdAt: new Date().toISOString(),
        mode: sendMode
      }
      const assistantId = localId()
      streamingIdRef.current = assistantId
      const assistantMsg: DisplayMessage = {
        id: assistantId,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        // The end-practice reply is coaching feedback, not an in-character
        // buyer line — render it (and persist it) as advisor even though the
        // triggering user turn was still tagged 'practice'.
        mode: sendMode,
        streaming: true
      }
      setMessages((prev) => [...prev, userMsg, assistantMsg])

      const startFresh = sendMode === 'practice' && freshPracticeRef.current
      if (sendMode === 'practice') freshPracticeRef.current = false

      try {
        const res = await window.api.coachChat.send(callId, trimmed, sendMode, startFresh)
        if (!mountedRef.current) return
        if (res.ok) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, text: res.reply ?? m.text, streaming: false }
                : m.id === userMsg.id
                  ? { ...m, suggestions: res.suggestions?.length ? res.suggestions : undefined }
                  : m
            )
          )
        } else {
          setError(res.message ?? 'Something went wrong. Please try again.')
          setMessages((prev) => prev.filter((m) => m.id !== assistantId))
        }
      } catch {
        if (!mountedRef.current) return
        setError('Something went wrong. Please try again.')
        setMessages((prev) => prev.filter((m) => m.id !== assistantId))
      } finally {
        streamingIdRef.current = null
        if (mountedRef.current) setSending(false)
      }
    },
    [callId, mode, sending]
  )

  const endPractice = useCallback(async (): Promise<void> => {
    await send('end practice', 'practice')
  }, [send])

  const applySuggestion = useCallback(
    async (messageId: string, suggestion: CoachChatContextSuggestion): Promise<boolean> => {
      try {
        const res = await window.api.coachChat.applySuggestion(callId, suggestion)
        if (res.ok && mountedRef.current) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? { ...m, appliedSuggestionIds: [...(m.appliedSuggestionIds ?? []), suggestion.id] }
                : m
            )
          )
        }
        return res.ok
      } catch {
        return false
      }
    },
    [callId]
  )

  const draftFollowUpEmail = useCallback(async (): Promise<void> => {
    if (sending) return
    setError(null)
    setSending(true)
    try {
      const res = await window.api.coachChat.draftFollowUpEmail(callId)
      if (!mountedRef.current) return
      const replyText = res.ok ? res.reply : undefined
      if (replyText) {
        setMessages((prev) => [
          ...prev,
          {
            id: localId(),
            role: 'user',
            text: 'Draft a follow-up email for this call.',
            createdAt: new Date().toISOString(),
            mode: 'advisor'
          },
          {
            id: localId(),
            role: 'assistant',
            text: replyText,
            createdAt: new Date().toISOString(),
            mode: 'advisor'
          }
        ])
      } else {
        setError(res.message ?? 'Could not draft a follow-up email.')
      }
    } catch {
      if (mountedRef.current) setError('Could not draft a follow-up email.')
    } finally {
      if (mountedRef.current) setSending(false)
    }
  }, [callId, sending])

  const proposeTask = useCallback(async (): Promise<CoachChatTaskProposal | null> => {
    try {
      const res = await window.api.coachChat.proposeTask(callId)
      if (res.ok) return res.proposal
      setError(res.message)
      return null
    } catch {
      setError('Could not come up with a task for this call.')
      return null
    }
  }, [callId])

  const confirmTask = useCallback(
    async (proposal: CoachChatTaskProposal): Promise<boolean> => {
      try {
        const res = await window.api.coachChat.confirmTask(callId, proposal)
        if (!res.ok) setError('Could not add that task. Please try again.')
        return res.ok
      } catch {
        setError('Could not add that task. Please try again.')
        return false
      }
    },
    [callId]
  )

  const regenerateCrmNote = useCallback(async (): Promise<string | null> => {
    try {
      const res = await window.api.coachChat.regenerateCrmNote(callId)
      if (res.ok) return res.note
      setError(res.message)
      return null
    } catch {
      setError('Could not draft a note. Please try again.')
      return null
    }
  }, [callId])

  const saveCrmNote = useCallback(
    async (note: string): Promise<boolean> => {
      try {
        const res = await window.api.coachChat.saveCrmNote(callId, note)
        if (!res.ok) setError('Could not save that note. Please try again.')
        return res.ok
      } catch {
        setError('Could not save that note. Please try again.')
        return false
      }
    },
    [callId]
  )

  return {
    messages,
    mode,
    setMode,
    sending,
    error,
    send,
    endPractice,
    applySuggestion,
    draftFollowUpEmail,
    proposeTask,
    confirmTask,
    regenerateCrmNote,
    saveCrmNote
  }
}
