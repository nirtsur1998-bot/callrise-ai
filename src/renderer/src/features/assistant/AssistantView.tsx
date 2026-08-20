// M28 — the Rise section: conversation list + chat. The screen is a thin
// shell over main-owned state (conversations on disk, in-flight turns in
// assistant-ipc); navigation can destroy this component at any moment and
// nothing of value is lost — useAssistantChat re-attaches on the way back.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Loader2,
  MessageSquarePlus,
  Pencil,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
  Check,
  BookOpenCheck
} from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { EmptyState } from '@renderer/components/EmptyState'
import { Modal } from '@renderer/components/Modal'
import { cn } from '@renderer/lib/cn'
import { fieldClass } from '@renderer/components/field'
import { ASSISTANT_SECTION_NAME } from './config'
import {
  useAssistantChat,
  type AssistantCitation,
  type AssistantMessage,
  type AssistantSuggestion,
  type DisplayMessage
} from './useAssistantChat'

type ConversationMeta = Awaited<ReturnType<typeof window.api.assistant.listConversations>>[number]
type MemoryEvidence = NonNullable<
  Awaited<ReturnType<typeof window.api.assistant.getMemoryEvidence>>
>

const STARTER_PROMPTS = [
  'What do you know about my business?',
  'What am I strongest at on calls — and weakest?',
  'What should I focus on this week?'
]

const STATUS_LABEL: Record<MemoryEvidence['status'], string> = {
  active: 'Trusted fact',
  hypothesis: 'Still a hunch',
  invalidated: 'Replaced',
  archived: 'Forgotten'
}

function relativeDay(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Render an assistant reply's [n] markers as tappable citation chips.
 *  Distinct markers in first-occurrence order map onto `citations` in order —
 *  the same rule main used to build the persisted list (context.ts). */
function CitedText({
  text,
  citations,
  onCite
}: {
  text: string
  citations: AssistantCitation[] | undefined
  onCite: (c: AssistantCitation) => void
}): React.JSX.Element {
  const nodes = useMemo(() => {
    const parts = text.split(/(\[\d{1,2}\])/g)
    const markerToIndex = new Map<string, number>()
    for (const part of parts) {
      if (/^\[\d{1,2}\]$/.test(part) && !markerToIndex.has(part)) {
        markerToIndex.set(part, markerToIndex.size)
      }
    }
    return parts.map((part, i) => {
      const idx = markerToIndex.get(part)
      const citation = idx !== undefined && citations ? citations[idx] : undefined
      if (citation) {
        return (
          <button
            key={i}
            type="button"
            onClick={() => onCite(citation)}
            title={citation.label}
            className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent-soft px-1 align-super text-[10px] font-semibold text-accent hover:brightness-110"
          >
            {idx! + 1}
          </button>
        )
      }
      // Unmatched markers (mid-stream, or model inventions) render as-is.
      return <span key={i}>{part}</span>
    })
  }, [text, citations, onCite])
  return <span className="whitespace-pre-wrap">{nodes}</span>
}

function Bubble({
  message,
  onCite,
  onApplySuggestion
}: {
  message: DisplayMessage
  onCite: (c: AssistantCitation) => void
  onApplySuggestion: (messageId: string, s: AssistantSuggestion) => void
}): React.JSX.Element {
  const isUser = message.role === 'user'
  const applied = new Set(message.appliedSuggestionIds ?? [])
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed',
          isUser
            ? 'bg-accent-soft text-ink'
            : 'border border-line-soft bg-surface text-ink shadow-card'
        )}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap">{message.text}</span>
        ) : (
          <>
            <CitedText text={message.text} citations={message.citations} onCite={onCite} />
            {message.streaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />
            )}
          </>
        )}
        {isUser && message.suggestions && message.suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.suggestions.map((s) => {
              const isApplied = applied.has(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={isApplied}
                  onClick={() => onApplySuggestion(message.id, s)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px]',
                    isApplied
                      ? 'border-line-soft text-faint'
                      : 'border-accent/40 text-accent hover:bg-accent-soft'
                  )}
                >
                  {isApplied ? <Check className="h-3 w-3" /> : <BookOpenCheck className="h-3 w-3" />}
                  {isApplied ? 'Saved' : 'Save to Sales Brain'}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function EvidenceModal({
  citation,
  onClose,
  onOpenCall
}: {
  citation: AssistantCitation
  onClose: () => void
  onOpenCall?: (callId: string) => void
}): React.JSX.Element {
  const [evidence, setEvidence] = useState<MemoryEvidence | null | 'loading'>('loading')
  useEffect(() => {
    if (citation.kind !== 'memory') {
      setEvidence(null)
      return
    }
    void window.api.assistant.getMemoryEvidence(citation.id).then(setEvidence)
  }, [citation])

  return (
    <Modal onClose={onClose} title="Where this comes from" size="md">
      {evidence === 'loading' ? (
        <div className="flex items-center gap-2 py-6 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading evidence…
        </div>
      ) : evidence === null ? (
        <p className="py-4 text-[13px] text-muted">
          This memory is no longer available — it may have been deleted or Sales Brain is off. The
          citation label was: &ldquo;{citation.label}&rdquo;
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-[14px] font-medium text-ink">{evidence.statement}</p>
          <p className="text-[12px] text-muted">
            {STATUS_LABEL[evidence.status]} · {Math.round(evidence.confidence * 100)}% confidence ·{' '}
            {evidence.category}
          </p>
          <div className="space-y-2">
            {evidence.evidence.map((e, i) =>
              e.type === 'transcript' ? (
                <div key={i} className="rounded-xl border border-line-soft bg-elevated p-3">
                  <p className="text-[12.5px] italic text-muted">&ldquo;{e.quote}&rdquo;</p>
                  {onOpenCall && !e.callId.includes(':') && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose()
                        onOpenCall(e.callId)
                      }}
                      className="mt-1.5 text-[12px] font-medium text-accent hover:underline"
                    >
                      Open the call →
                    </button>
                  )}
                  {e.callId.startsWith('assistant:') && (
                    <p className="mt-1 text-[11px] text-faint">Said in a chat with {ASSISTANT_SECTION_NAME}</p>
                  )}
                  {e.callId.startsWith('onboarding:') && (
                    <p className="mt-1 text-[11px] text-faint">From your onboarding interview</p>
                  )}
                </div>
              ) : (
                <div key={i} className="rounded-xl border border-line-soft bg-elevated p-3">
                  <p className="text-[12px] text-muted">
                    Synthesized from {e.memoryIds.length} other memories (reflection)
                  </p>
                </div>
              )
            )}
            {evidence.evidence.length === 0 && (
              <p className="text-[12px] text-faint">No recorded quotes for this memory.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function ConversationRow({
  meta,
  active,
  onSelect,
  onRename,
  onDelete
}: {
  meta: ConversationMeta
  active: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.title)
  return (
    <div
      className={cn(
        'group relative cursor-pointer rounded-xl px-3 py-2.5',
        active ? 'bg-accent-soft' : 'hover:bg-elevated'
      )}
      onClick={editing ? undefined : onSelect}
    >
      {editing ? (
        <div className="flex items-center gap-1">
          <input
            className={cn(fieldClass, 'h-7 flex-1 text-[12.5px]')}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename(draft)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <IconButton
            icon={X}
            label="Cancel"
            onClick={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-[13px] font-medium text-ink">{meta.title}</p>
            <span className="shrink-0 text-[10.5px] text-faint">{relativeDay(meta.updatedAt)}</span>
          </div>
          {meta.preview && <p className="mt-0.5 truncate text-[11.5px] text-faint">{meta.preview}</p>}
          <div
            className="absolute right-1.5 top-1.5 hidden gap-0.5 rounded-lg bg-surface/90 p-0.5 group-hover:flex"
            onClick={(e) => e.stopPropagation()}
          >
            <IconButton
              icon={Pencil}
              label="Rename"
              onClick={() => {
                setDraft(meta.title)
                setEditing(true)
              }}
            />
            <IconButton icon={Trash2} label="Delete" onClick={onDelete} />
          </div>
        </>
      )}
    </div>
  )
}

export function AssistantView({
  onOpenCall
}: {
  onOpenCall?: (callId: string) => void
}): React.JSX.Element {
  const [metas, setMetas] = useState<ConversationMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [citation, setCitation] = useState<AssistantCitation | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chat = useAssistantChat(activeId)

  const refreshList = useCallback(async (): Promise<void> => {
    setMetas(await window.api.assistant.listConversations())
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  // Keep the list's previews/ordering fresh as turns complete (this window
  // or another). Cheap local-disk read.
  useEffect(
    () =>
      window.api.assistant.onTurnComplete(() => {
        void refreshList()
      }),
    [refreshList]
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [chat.messages])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return metas
    return metas.filter(
      (m) => m.title.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q)
    )
  }, [metas, query])

  const startConversation = useCallback(
    async (firstMessage?: string): Promise<void> => {
      const conv = await window.api.assistant.createConversation()
      setActiveId(conv.id)
      await refreshList()
      if (firstMessage) {
        // Fire-and-forget: the hook attached to the new id renders the stream.
        void window.api.assistant.send(conv.id, firstMessage)
      }
    },
    [refreshList]
  )

  const handleSend = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || chat.sending) return
    setDraft('')
    if (!activeId) {
      await startConversation(text)
      return
    }
    await chat.send(text)
    void refreshList()
  }, [draft, chat, activeId, startConversation, refreshList])

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      if (!window.confirm('Delete this conversation? This cannot be undone.')) return
      await window.api.assistant.deleteConversation(id)
      if (activeId === id) setActiveId(null)
      void refreshList()
    },
    [activeId, refreshList]
  )

  const handleRename = useCallback(
    async (id: string, title: string): Promise<void> => {
      await window.api.assistant.renameConversation(id, title)
      void refreshList()
    },
    [refreshList]
  )

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* Conversation rail */}
      <aside className="flex w-72 shrink-0 flex-col rounded-2xl border border-line-soft bg-surface shadow-card">
        <div className="space-y-2 p-3">
          <Button
            fullWidth
            icon={MessageSquarePlus}
            onClick={() => {
              setActiveId(null)
              setDraft('')
            }}
          >
            New chat
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              className={cn(fieldClass, 'h-8 w-full pl-8 text-[12.5px]')}
              placeholder="Search conversations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
          {filtered.map((m) => (
            <ConversationRow
              key={m.id}
              meta={m}
              active={m.id === activeId}
              onSelect={() => setActiveId(m.id)}
              onRename={(title) => void handleRename(m.id, title)}
              onDelete={() => void handleDelete(m.id)}
            />
          ))}
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-faint">
              {metas.length === 0 ? 'No conversations yet.' : 'Nothing matches your search.'}
            </p>
          )}
        </div>
      </aside>

      {/* Chat pane */}
      <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-line-soft bg-surface shadow-card">
        {activeId === null && chat.messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8">
            <EmptyState
              icon={Sparkles}
              title={`Ask ${ASSISTANT_SECTION_NAME} anything`}
              description="Grounded in your Sales Brain — your calls, clients, deals, and selling patterns. Every claim cites where it came from."
            />
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void startConversation(p)}
                  className="rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-muted hover:border-accent/50 hover:text-ink"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
            {chat.loading && (
              <div className="flex items-center gap-2 text-[12.5px] text-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            )}
            {chat.messages.map((m) => (
              <Bubble
                key={m.id}
                message={m}
                onCite={setCitation}
                onApplySuggestion={(messageId, s) => void chat.applySuggestion(messageId, s)}
              />
            ))}
          </div>
        )}

        {chat.error && (
          <div className="mx-5 mb-2 flex items-center justify-between rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            <span>{chat.error}</span>
            <IconButton icon={X} label="Dismiss" onClick={chat.clearError} />
          </div>
        )}

        <div className="border-t border-line-soft p-3">
          <div className="flex items-end gap-2">
            <textarea
              rows={2}
              className={cn(fieldClass, 'flex-1 resize-none text-[13px]')}
              placeholder={`Message ${ASSISTANT_SECTION_NAME}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
            />
            {chat.sending ? (
              <Button variant="secondary" icon={Square} onClick={() => void chat.stop()}>
                Stop
              </Button>
            ) : (
              <Button icon={Send} onClick={() => void handleSend()} disabled={!draft.trim()}>
                Send
              </Button>
            )}
          </div>
        </div>
      </div>

      {citation && (
        <EvidenceModal citation={citation} onClose={() => setCitation(null)} onOpenCall={onOpenCall} />
      )}
    </div>
  )
}

// Re-exported so MainApp's lazy() import shape matches every other screen.
export type { AssistantMessage }
