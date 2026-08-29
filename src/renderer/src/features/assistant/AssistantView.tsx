// M28 — the Rise section, rebuilt to the approved P1 direction: ONE surface,
// one reading column. No boxes-in-boxes — the rail is a flat panel behind a
// hairline divider, the chat IS the page, the composer is a single unified
// object pinned to the bottom of the viewport. User messages are compact
// accent bubbles; Rise's replies are flat document-style text with real
// (block-progressive) markdown. The screen is disposable by design — main
// owns conversations and in-flight turns; useAssistantChat re-attaches.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Loader2,
  MessageSquarePlus,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
  Check,
  BookOpenCheck,
  Brain,
  BrainCog,
  Mic,
  Pause,
  Play,
  Paperclip,
  UserRound,
  FileText,
  Image as ImageIcon
} from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { Modal } from '@renderer/components/Modal'
import { Skeleton, SkeletonRows } from '@renderer/components/Skeleton'
import { cn } from '@renderer/lib/cn'
import { fieldClass } from '@renderer/components/field'
import { ASSISTANT_SECTION_NAME } from './config'
import {
  useAssistantChat,
  type AssistantAttachment,
  type AssistantCitation,
  type AssistantScope,
  type AssistantSuggestion,
  type DisplayMessage
} from './useAssistantChat'
import { useVoiceNote } from './useVoiceNote'
import type { AssistantScopeRequest } from './assistantNav'
import { segmentCitedText } from './citation-markers'
import { splitBlocks, tokenizeInline, TABLE_CELL_SEP, type MdBlock } from './markdown-blocks'

type ConversationMeta = Awaited<ReturnType<typeof window.api.assistant.listConversations>>[number]
type MemoryEvidence = NonNullable<
  Awaited<ReturnType<typeof window.api.assistant.getMemoryEvidence>>
>

const STARTER_PROMPTS = [
  'What do you know about my business?',
  'What am I strongest at on calls — and weakest?',
  'What should I focus on this week?'
]

/** M28 Part 4 — prompts change when the conversation is about one client. */
function scopedPrompts(scope: AssistantScope): string[] {
  const first = scope.contactName.split(' ')[0]
  return [
    scope.dealTitle ? `What's blocking the ${scope.dealTitle} deal?` : `Where do we stand with ${first}?`,
    `How should I open the next call with ${first}?`,
    `What objections has ${first} raised, and what worked?`,
    `Summarize everything we know about ${first}`
  ]
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

interface PendingAttachment {
  attachment: AssistantAttachment
  preview: string
  /** AUDIT FIX (2026-08-24) — which conversation this file was staged for.
   *  pendingFiles is component state that no setActiveId site cleared, so a
   *  file staged in client A's scoped chat stayed in the composer when the
   *  user clicked client B's conversation in the rail and was sent into B's
   *  turn. Stamping the owner lets the composer prune precisely, rather than
   *  relying on every future navigation path remembering to reset. */
  conversationId: string
}

/** One attached-file chip — on a sent message (compact) or in the composer
 *  (with the honest "what will be sent" preview and a remove control). */
function AttachmentChip({
  attachment,
  preview,
  onRemove
}: {
  attachment: AssistantAttachment
  preview?: string
  onRemove?: () => void
}): React.JSX.Element {
  const Icon = attachment.kind === 'image' ? ImageIcon : FileText
  return (
    <div
      className="flex max-w-full items-start gap-2 rounded-xl border border-line-soft bg-surface px-2.5 py-1.5 text-[12px]"
      title={preview}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{attachment.name}</p>
        <p className="text-[11px] text-faint">
          {formatBytes(attachment.sizeBytes)}
          {attachment.kind === 'text' && attachment.extractedChars !== undefined
            ? ` · ${attachment.extractedChars.toLocaleString()} characters of text will be sent`
            : attachment.kind === 'image'
              ? ' · sent as an image (needs a vision-capable model)'
              : ' · sent as a PDF'}
        </p>
        {preview && attachment.kind === 'text' && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] text-muted">{preview}</p>
        )}
      </div>
      {onRemove && <IconButton icon={X} label={`Remove ${attachment.name}`} onClick={onRemove} />}
    </div>
  )
}

/** M28 Part 4 — pick a client to talk about. Contacts come from the local
 *  CRM list (same call the command palette makes). */
function ScopePickerModal({
  onClose,
  onPick
}: {
  onClose: () => void
  onPick: (scope: AssistantScope) => void
}): React.JSX.Element {
  const [contacts, setContacts] = useState<{ id: string; name: string; company?: string }[] | null>(
    null
  )
  const [q, setQ] = useState('')
  useEffect(() => {
    void window.api.contacts
      .list()
      .then((rows) => setContacts(rows.map((c) => ({ id: c.id, name: c.name, company: c.company }))))
      .catch(() => setContacts([]))
  }, [])
  const filtered = useMemo(() => {
    if (!contacts) return []
    const needle = q.trim().toLowerCase()
    return contacts
      .filter((c) => !needle || `${c.name} ${c.company ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 50)
  }, [contacts, q])
  return (
    <Modal onClose={onClose} title="Talk about a client" size="sm">
      <input
        className={cn(fieldClass, 'h-9 w-full text-[13px]')}
        placeholder="Search contacts"
        aria-label="Search contacts"
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="mt-2 max-h-[50vh] space-y-0.5 overflow-y-auto">
        {contacts === null ? (
          <Skeleton className="h-8" />
        ) : filtered.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-faint">No contacts match.</p>
        ) : (
          filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick({ contactId: c.id, contactName: c.name, company: c.company })}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <UserRound className="h-3.5 w-3.5 text-muted" />
              <span className="truncate text-[13px] text-ink">{c.name}</span>
              {c.company && <span className="truncate text-[11.5px] text-faint">· {c.company}</span>}
            </button>
          ))
        )}
      </div>
    </Modal>
  )
}

const STATUS_LABEL: Record<MemoryEvidence['status'], string> = {
  active: 'Trusted fact',
  hypothesis: 'Still a hunch',
  invalidated: 'Replaced',
  archived: 'Forgotten'
}

const PHASE_LABEL: Record<'reading' | 'searching' | 'thinking', string> = {
  reading: 'Reading your Sales Brain…',
  searching: 'Searching your calls, contacts, and calendar…',
  thinking: 'Thinking…'
}

function relativeDay(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const days = Math.floor(
    (today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000
  )
  if (days <= 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- Markdown-with-citations rendering --------------------------------------

/** One inline text run: code spans, bold, and italic composed with citation
 *  chips. Chips keep a REAL hit target (20px, 11px type) through the density
 *  pass — they're the trust mechanism and get clicked constantly. */
function InlineRun({
  text,
  citations,
  onCite
}: {
  text: string
  citations: AssistantCitation[] | undefined
  onCite: (c: AssistantCitation) => void
}): React.JSX.Element {
  const nodes: React.ReactNode[] = []
  tokenizeInline(text).forEach((token, ti) => {
    if (token.type === 'code') {
      nodes.push(
        <code key={ti} className="rounded bg-elevated px-1 py-0.5 font-mono text-[12px] text-ink">
          {token.text}
        </code>
      )
      return
    }
    const segments = segmentCitedText(token.text, citations)
    const rendered = segments.map((seg, si) =>
      seg.type === 'chip' ? (
        <button
          key={si}
          type="button"
          onClick={() => onCite(seg.citation)}
          title={seg.citation.label}
          aria-label={`Source ${seg.marker}: ${seg.citation.label}`}
          className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-accent-soft px-1.5 align-[-0.15em] text-[11px] font-semibold text-accent hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {seg.marker}
        </button>
      ) : (
        <span key={si}>{seg.text}</span>
      )
    )
    if (token.type === 'bold') nodes.push(<strong key={ti}>{rendered}</strong>)
    else if (token.type === 'italic') nodes.push(<em key={ti}>{rendered}</em>)
    else nodes.push(<span key={ti}>{rendered}</span>)
  })
  return <>{nodes}</>
}

const BlockView = memo(
  function BlockView({
    block,
    citations,
    onCite
  }: {
    block: MdBlock
    citations: AssistantCitation[] | undefined
    onCite: (c: AssistantCitation) => void
  }): React.JSX.Element {
    switch (block.kind) {
      case 'heading': {
        const level = block.meta === '1' ? 'text-[16px]' : block.meta === '2' ? 'text-[15px]' : 'text-[14px]'
        return (
          <p className={cn('mt-3 font-semibold tracking-tight text-ink first:mt-0', level)}>
            <InlineRun text={block.lines[0]} citations={citations} onCite={onCite} />
          </p>
        )
      }
      case 'table': {
        // AUDIT FIX (2026-08-25) — tables had no block kind at all and came
        // out as a wall of pipe characters. Scrolls inside its own container
        // so a wide table never forces the chat column to scroll sideways.
        const header = (block.meta ?? '').split(TABLE_CELL_SEP)
        return (
          <div className="my-2 overflow-x-auto rounded-xl border border-line-soft">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-line-soft bg-elevated">
                  {header.map((h, i) => (
                    <th key={i} className="px-2.5 py-1.5 text-left font-semibold text-ink">
                      <InlineRun text={h} citations={citations} onCite={onCite} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.lines.map((row, r) => (
                  <tr key={r} className="border-b border-line-soft last:border-0">
                    {row.split(TABLE_CELL_SEP).map((cell, c) => (
                      <td key={c} className="px-2.5 py-1.5 align-top text-muted">
                        <InlineRun text={cell} citations={citations} onCite={onCite} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      case 'code':
        return (
          <pre className="my-2 overflow-x-auto rounded-xl border border-line-soft bg-elevated p-3 font-mono text-[12px] leading-relaxed text-ink">
            {block.lines.join('\n')}
          </pre>
        )
      case 'bullet-list':
        return (
          <ul className="my-1.5 space-y-1 pl-5">
            {block.lines.map((l, i) => (
              <li key={i} className="list-disc marker:text-faint">
                <InlineRun text={l} citations={citations} onCite={onCite} />
              </li>
            ))}
          </ul>
        )
      case 'ordered-list':
        return (
          <ol className="my-1.5 space-y-1 pl-5">
            {block.lines.map((l, i) => (
              <li key={i} className="list-decimal marker:text-faint">
                <InlineRun text={l} citations={citations} onCite={onCite} />
              </li>
            ))}
          </ol>
        )
      case 'quote':
        return (
          <blockquote className="my-2 border-l-2 border-line pl-3 text-muted">
            {block.lines.map((l, i) => (
              <p key={i}>
                <InlineRun text={l} citations={citations} onCite={onCite} />
              </p>
            ))}
          </blockquote>
        )
      default:
        return (
          <p className="my-1.5 first:mt-0 last:mb-0">
            {block.lines.map((l, i) => (
              <span key={i}>
                {i > 0 && <br />}
                <InlineRun text={l} citations={citations} onCite={onCite} />
              </span>
            ))}
          </p>
        )
    }
  },
  (prev, next) =>
    prev.block === next.block && prev.citations === next.citations && prev.onCite === next.onCite
)

/** Block-progressive markdown: complete blocks are memoized (block objects
 *  are reference-stable via content keying below), the trailing in-progress
 *  block renders as plain text — no reflow behind the reader. */
function MarkdownMessage({
  text,
  streaming,
  citations,
  onCite
}: {
  text: string
  streaming: boolean
  citations: AssistantCitation[] | undefined
  onCite: (c: AssistantCitation) => void
}): React.JSX.Element {
  const blockCacheRef = useRef(new Map<string, MdBlock>())
  const { blocks, trailing } = useMemo(() => {
    const split = splitBlocks(text, !streaming)
    // Reference-stability: identical raw content -> the SAME block object,
    // so BlockView's memo comparison short-circuits for settled blocks.
    const cache = blockCacheRef.current
    const stable = split.blocks.map((b) => {
      const key = `${b.kind}:${b.meta ?? ''}:${b.lines.join('\n')}`
      const hit = cache.get(key)
      if (hit) return hit
      cache.set(key, b)
      return b
    })
    return { blocks: stable, trailing: split.trailing }
  }, [text, streaming])

  return (
    <div className="text-[13.5px] leading-relaxed text-ink">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} citations={citations} onCite={onCite} />
      ))}
      {trailing && (
        <p className="my-1.5 whitespace-pre-wrap first:mt-0 last:mb-0">
          <InlineRun text={trailing} citations={citations} onCite={onCite} />
        </p>
      )}
    </div>
  )
}

// --- Message rows ------------------------------------------------------------

function VoiceNoteChip({
  mediaId,
  durationMs
}: {
  mediaId: string
  durationMs: number
}): React.JSX.Element {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(
    () => () => {
      audioRef.current?.pause()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    []
  )

  const toggle = useCallback(async (): Promise<void> => {
    if (playing) {
      audioRef.current?.pause()
      setPlaying(false)
      return
    }
    if (!audioRef.current) {
      const bytes = await window.api.assistant.getVoiceNote(mediaId)
      if (!bytes) return
      urlRef.current = URL.createObjectURL(new Blob([bytes], { type: 'audio/webm' }))
      audioRef.current = new Audio(urlRef.current)
      audioRef.current.onended = () => setPlaying(false)
    }
    void audioRef.current.play()
    setPlaying(true)
  }, [playing, mediaId])

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      aria-label={playing ? 'Pause voice note' : 'Play voice note'}
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-line-soft bg-surface px-2.5 py-1 text-[11.5px] text-muted hover:text-ink"
    >
      {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      Voice note · {formatDuration(durationMs)}
    </button>
  )
}

function MessageRow({
  message,
  phase,
  onCite,
  onApplySuggestion,
  onConfirmTask
}: {
  message: DisplayMessage
  phase: 'reading' | 'searching' | 'thinking' | null
  onCite: (c: AssistantCitation) => void
  onApplySuggestion: (messageId: string, s: AssistantSuggestion) => void
  onConfirmTask: (messageId: string, proposalId: string) => void
}): React.JSX.Element {
  if (message.role === 'user') {
    const applied = new Set(message.appliedSuggestionIds ?? [])
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent-soft px-3.5 py-2 text-[13.5px] leading-relaxed text-ink">
          <span className="whitespace-pre-wrap">{message.text}</span>
          {message.voiceNote && (
            <div>
              <VoiceNoteChip
                mediaId={message.voiceNote.mediaId}
                durationMs={message.voiceNote.durationMs}
              />
            </div>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} />
              ))}
            </div>
          )}
          {message.suggestions && message.suggestions.length > 0 && (
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
                        : 'border-accent/40 text-accent hover:bg-surface'
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

  // Rise's reply: flat document text with a small glyph gutter — no bubble.
  const showActivity = message.streaming && message.text === '' && phase
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
        <Sparkles className="h-3.5 w-3.5 text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        {showActivity ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {PHASE_LABEL[phase]}
          </p>
        ) : (
          <>
            <MarkdownMessage
              text={message.text}
              streaming={Boolean(message.streaming)}
              citations={message.citations}
              onCite={onCite}
            />
            {message.streaming && message.text !== '' && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />
            )}
          </>
        )}
        {message.taskProposals && message.taskProposals.length > 0 && (
          <div className="mt-2.5 space-y-2">
            {message.taskProposals.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line-soft bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-medium text-ink">{p.title}</p>
                  <p className="text-[11.5px] text-faint">
                    {p.type} · {p.priority} priority
                  </p>
                </div>
                {p.status === 'accepted' ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-positive">
                    <Check className="h-3.5 w-3.5" /> Added
                  </span>
                ) : (
                  <Button size="sm" onClick={() => onConfirmTask(message.id, p.id)}>
                    Add task
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Evidence modal ----------------------------------------------------------

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
    if (citation.kind !== 'memory') return
    void window.api.assistant.getMemoryEvidence(citation.id).then(setEvidence)
  }, [citation])

  const closeButton = (
    <div className="mt-4 flex justify-end">
      <Button variant="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  )

  if (citation.kind === 'call') {
    return (
      <Modal onClose={onClose} title="Where this comes from" size="md">
        <div className="space-y-3">
          <p className="text-[14px] font-medium text-ink">&ldquo;{citation.label}&rdquo;</p>
          <p className="text-[12px] text-muted">A call from your history.</p>
          {onOpenCall ? (
            <Button
              onClick={() => {
                onClose()
                onOpenCall(citation.id)
              }}
            >
              Open the call
            </Button>
          ) : (
            <p className="text-[12px] text-faint">Find it in Past Calls.</p>
          )}
        </div>
        {closeButton}
      </Modal>
    )
  }

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
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
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
                    <p className="mt-1 text-[11.5px] text-faint">
                      Said in a chat with {ASSISTANT_SECTION_NAME}
                    </p>
                  )}
                  {e.callId.startsWith('onboarding:') && (
                    <p className="mt-1 text-[11.5px] text-faint">From your onboarding interview</p>
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
      {closeButton}
    </Modal>
  )
}

// --- Confirm dialog (replaces window.confirm — on-system, focus-managed) -----

interface ConfirmState {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }): React.JSX.Element {
  return (
    <Modal onClose={onClose} title={state.title} size="sm">
      <p className="text-[13px] leading-relaxed text-muted">{state.body}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            onClose()
            state.onConfirm()
          }}
        >
          {state.confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}

// --- Conversation rail -------------------------------------------------------

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
  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <input
          className={cn(fieldClass, 'h-7 flex-1 text-[12.5px]')}
          value={draft}
          autoFocus
          aria-label="Conversation name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRename(draft)
              setEditing(false)
            }
            if (e.key === 'Escape') setEditing(false)
          }}
        />
        <IconButton icon={X} label="Cancel rename" onClick={() => setEditing(false)} />
      </div>
    )
  }
  return (
    // A real button (keyboard-reachable), with actions that appear on hover
    // OR keyboard focus-within — audit H: no mouse-only controls.
    <div className={cn('group relative rounded-lg', active ? 'bg-accent-soft' : 'hover:bg-elevated focus-within:bg-elevated')}>
      <button
        type="button"
        onClick={onSelect}
        className="w-full px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12.5px] font-medium text-ink">{meta.title}</span>
          <span className="shrink-0 text-[11px] text-faint">{relativeDay(meta.updatedAt)}</span>
        </span>
        {meta.preview && (
          <span className="mt-0.5 block truncate text-[11.5px] text-faint">{meta.preview}</span>
        )}
      </button>
      <div className="absolute right-1 top-1 hidden gap-0.5 rounded-md bg-surface/95 p-0.5 group-hover:flex group-focus-within:flex">
        <IconButton
          icon={Pencil}
          label="Rename conversation"
          onClick={() => {
            setDraft(meta.title)
            setEditing(true)
          }}
        />
        <IconButton icon={Trash2} label="Delete conversation" onClick={onDelete} />
      </div>
    </div>
  )
}

// --- The screen --------------------------------------------------------------

export function AssistantView({
  onOpenCall,
  initialScope = null,
  onInitialScopeConsumed
}: {
  onOpenCall?: (callId: string) => void
  /** M28 Part 4 — one-shot: open a NEW conversation about this client
   *  (from a contact/deal/call page). Consumed once acted on. */
  initialScope?: AssistantScopeRequest | null
  onInitialScopeConsumed?: () => void
}): React.JSX.Element {
  const [metas, setMetas] = useState<ConversationMeta[] | null>(null) // null = loading
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [citation, setCitation] = useState<AssistantCitation | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // AUDIT FIX (2026-08-24) — the real status, not a boolean that conflated
  // "off" (the shipping default), "unavailable" (migration failed) and
  // "empty" into one message that named the wrong cause for two of them.
  const [brainStatus, setBrainStatus] = useState<SalesBrainStatus | null>(null)
  const [pendingFirst, setPendingFirst] = useState<{
    convId: string
    text: string
    voiceNote?: { mediaId: string; durationMs: number }
    attachments?: AssistantAttachment[]
  } | null>(null)
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([])
  const [scopePickerOpen, setScopePickerOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const chat = useAssistantChat(
    activeId,
    pendingFirst && pendingFirst.convId === activeId
      ? {
          initialMessage: {
            text: pendingFirst.text,
            voiceNote: pendingFirst.voiceNote,
            attachments: pendingFirst.attachments
          }
        }
      : undefined
  )
  const voice = useVoiceNote({
    onTranscript: (text) => setDraft((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text))
  })

  const refreshList = useCallback(async (): Promise<void> => {
    setMetas(await window.api.assistant.listConversations())
  }, [])

  useEffect(() => {
    void refreshList()
    // Distinct empty states need the real status. This used to read
    // memories.list({}).length === 0, which is [] when Sales Brain is OFF,
    // [] when the DB failed to migrate, and [] when it is genuinely empty —
    // so the "unknown" catch branch below was dead for BOTH failure classes,
    // and every new user (Sales Brain ships off) was told to import their
    // call history, which cannot help until they switch it on.
    void window.api.salesBrain
      .status()
      .then(setBrainStatus)
      .catch(() => setBrainStatus(null))
  }, [refreshList])

  useEffect(
    () =>
      window.api.assistant.onTurnComplete(() => {
        void refreshList()
      }),
    [refreshList]
  )

  // Reader-respecting autoscroll (audit G): follow the stream only while the
  // user is already at the bottom; never yank them back up mid-read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTo({ top: el.scrollHeight })
  }, [chat.messages])

  // Escape cancels an active recording (audit H).
  useEffect(() => {
    if (voice.state !== 'recording') return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') voice.cancelRecording()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [voice])

  const filtered = useMemo(() => {
    if (!metas) return []
    const q = query.trim().toLowerCase()
    if (!q) return metas
    return metas.filter(
      (m) => m.title.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q)
    )
  }, [metas, query])

  const startConversation = useCallback(
    async (
      firstMessage?: string,
      voiceNote?: { mediaId: string; durationMs: number },
      attachments?: AssistantAttachment[],
      scope?: AssistantScope
    ): Promise<void> => {
      const conv = await window.api.assistant.createConversation(scope)
      if (firstMessage) {
        setPendingFirst({ convId: conv.id, text: firstMessage, voiceNote, attachments })
      }
      setActiveId(conv.id)
      await refreshList()
    },
    [refreshList]
  )

  // M28 Part 4 — arriving from a contact/deal/call page: open a new scoped
  // conversation. A caller that only knows the id (a call page) gets the
  // name resolved from the contact record here.
  useEffect(() => {
    if (!initialScope) return
    const req = initialScope
    onInitialScopeConsumed?.()
    void (async () => {
      let name = req.contactName
      let company = req.company
      if (!name) {
        const contact = (await window.api.contacts.list().catch(() => []))
          .find((c) => c.id === req.contactId)
        if (!contact) return
        name = contact.name
        company = contact.company
      }
      await startConversation(undefined, undefined, undefined, {
        contactId: req.contactId,
        contactName: name,
        company,
        dealId: req.dealId,
        dealTitle: req.dealTitle
      })
    })()
  }, [initialScope, onInitialScopeConsumed, startConversation])

  const addFiles = useCallback(async (files: FileList | null): Promise<void> => {
    if (!files) return
    // Every attachment needs a real owner at creation, so a file dropped into
    // the empty "new chat" state creates its conversation first. Attaching is
    // already the start of a conversation in every other sense; this just
    // makes that explicit early enough for the record to be bound.
    let convId = activeId
    if (!convId) {
      const conv = await window.api.assistant.createConversation()
      convId = conv.id
      setActiveId(conv.id)
      void refreshList()
    }
    const owner = convId
    // Seeded from what is already staged, then incremented from the
    // AUTHORITATIVE kind the main process assigns — the extension test above
    // is only a cheap pre-upload guess, and counting on it would let a
    // mislabelled file through.
    let pdfCount = pendingFiles.filter((p) => p.attachment.kind === 'pdf').length
    for (const file of Array.from(files).slice(0, 6)) {
      // AUDIT FIX (2026-08-25) — only ONE pdf can actually be sent
      // (req.document is singular across every provider adapter), and the
      // send path used to keep the first and discard the rest while every
      // chip still claimed success. Refuse the second here, where the user
      // can still do something about it, instead of letting a chip lie.
      if (new RegExp('\\.pdf$', 'i').test(file.name) && pdfCount >= 1) {
        setNotice(`Only one PDF per message — "${file.name}" was not attached.`)
        continue
      }
      const result = await window.api.assistant.addAttachment(
        file.name,
        await file.arrayBuffer(),
        owner
      )
      if (result.ok) {
        if (result.attachment.kind === 'pdf') pdfCount++
        setPendingFiles((prev) =>
          prev.length >= 6
            ? prev
            : [...prev, { attachment: result.attachment, preview: result.preview, conversationId: owner }]
        )
      } else {
        setNotice(result.message)
      }
    }
    // AUDIT FIX (2026-08-25) — these deps were `[]` while the body reads
    // activeId, which I introduced with the attachment-owner change. A stale
    // closure captured activeId as null at mount, so EVERY attach created and
    // switched to a brand-new conversation instead of using the open one.
  }, [activeId, pendingFiles, refreshList])

  const removePendingFile = useCallback((id: string): void => {
    void window.api.assistant.discardAttachment(id)
    setPendingFiles((prev) => prev.filter((p) => p.attachment.id !== id))
  }, [])

  // AUDIT FIX (2026-08-24) — staged files never survive a conversation
  // switch. Pruned by OWNER rather than blanket-cleared on every activeId
  // change, so the conversation that addFiles creates for a file dropped into
  // the empty state does not immediately discard that same file. Anything
  // pruned is discarded on disk too, rather than left as an orphan.
  useEffect(() => {
    setPendingFiles((prev) => {
      const keep = prev.filter((p) => p.conversationId === activeId)
      if (keep.length === prev.length) return prev
      for (const stale of prev) {
        if (stale.conversationId !== activeId) {
          void window.api.assistant.discardAttachment(stale.attachment.id)
        }
      }
      return keep
    })
  }, [activeId])

  const handleSend = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || chat.sending) return
    setDraft('')
    nearBottomRef.current = true
    const voiceNote = voice.pending ?? undefined
    voice.clearPending()
    const attachments = pendingFiles.map((p) => p.attachment)
    setPendingFiles([])
    if (!activeId) {
      await startConversation(text, voiceNote, attachments.length > 0 ? attachments : undefined)
      return
    }
    await chat.send(text, voiceNote, attachments.length > 0 ? attachments : undefined)
    void refreshList()
  }, [draft, chat, activeId, startConversation, refreshList, voice, pendingFiles])

  const handleDelete = useCallback(
    (id: string): void => {
      setConfirm({
        title: 'Delete conversation?',
        body: `This cannot be undone. Anything ${ASSISTANT_SECTION_NAME} learned from it stays in the Sales Brain — you can manage that in Settings → Sales Brain — Memories.`,
        confirmLabel: 'Delete',
        onConfirm: () => {
          void (async () => {
            await window.api.assistant.deleteConversation(id)
            if (activeId === id) setActiveId(null)
            void refreshList()
          })()
        }
      })
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

  const toggleLearning = useCallback((): void => {
    if (chat.learningExcluded) {
      void chat.setLearningExcluded(false)
      return
    }
    setConfirm({
      title: 'Stop learning from this conversation?',
      body: 'Anything it already taught the Sales Brain will be forgotten. This cannot be undone.',
      confirmLabel: 'Stop learning',
      onConfirm: () => {
        void chat.setLearningExcluded(true).then((ok) => {
          if (!ok) {
            setNotice(
              'Could not stop learning — Sales Brain storage is unavailable, so nothing could be forgotten. Try again after restarting the app.'
            )
          }
        })
      }
    })
  }, [chat])

  const activeMeta = metas?.find((m) => m.id === activeId) ?? null
  const showEmptyHero = activeId === null

  return (
    <div className="flex min-h-0 flex-1">
      {/* Conversation rail — flat, quiet, collapsible. Navigation, not product. */}
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-line-soft transition-[width] duration-150',
          railCollapsed ? 'w-12' : 'w-60'
        )}
      >
        <div className={cn('flex items-center gap-1 p-2', railCollapsed && 'flex-col')}>
          <IconButton
            icon={railCollapsed ? PanelLeftOpen : PanelLeftClose}
            label={railCollapsed ? 'Expand conversation list' : 'Collapse conversation list'}
            onClick={() => setRailCollapsed((v) => !v)}
          />
          {railCollapsed ? (
            <IconButton
              icon={MessageSquarePlus}
              label="New chat"
              onClick={() => {
                setActiveId(null)
                setDraft('')
                textareaRef.current?.focus()
              }}
            />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={MessageSquarePlus}
              className="flex-1"
              onClick={() => {
                setActiveId(null)
                setDraft('')
                textareaRef.current?.focus()
              }}
            >
              New chat
            </Button>
          )}
        </div>
        {!railCollapsed && (
          <>
            <div className="relative px-2 pb-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-[calc(50%+4px)] text-faint" />
              <input
                className={cn(fieldClass, 'h-8 w-full pl-8 text-[12.5px]')}
                placeholder="Search"
                aria-label="Search conversations"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              {metas === null ? (
                <div className="space-y-2 p-2">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : (
                <>
                  {filtered.map((m) => (
                    <ConversationRow
                      key={m.id}
                      meta={m}
                      active={m.id === activeId}
                      onSelect={() => setActiveId(m.id)}
                      onRename={(title) => void handleRename(m.id, title)}
                      onDelete={() => handleDelete(m.id)}
                    />
                  ))}
                  {filtered.length === 0 && (
                    <p className="px-3 py-6 text-center text-[12px] text-faint">
                      {metas.length === 0 ? 'No conversations yet.' : 'Nothing matches.'}
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </aside>

      {/* The chat IS the page: one surface, one reading column. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeId && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {chat.scope && (
                /* M28 Part 4 — the scope indicator: who Rise is talking about. */
                <span
                  className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-medium text-accent"
                  title={`This conversation is only about ${chat.scope.contactName}. Other clients' memories are never used here.`}
                >
                  <UserRound className="h-3.5 w-3.5" />
                  About {chat.scope.contactName}
                  {chat.scope.company ? ` · ${chat.scope.company}` : ''}
                </span>
              )}
              <p className="truncate text-[12.5px] font-medium text-muted">
                {activeMeta?.title ?? ''}
              </p>
            </div>
            <button
              type="button"
              onClick={toggleLearning}
              title={
                chat.learningExcluded
                  ? `${ASSISTANT_SECTION_NAME} is not learning from this conversation. Click to turn learning back on (it will not re-learn past messages).`
                  : `${ASSISTANT_SECTION_NAME} can save facts from this conversation to your Sales Brain — always visibly, never silently. Click to exclude this conversation and forget what it already taught.`
              }
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px]',
                chat.learningExcluded ? 'border-line text-faint' : 'border-accent/40 text-accent'
              )}
            >
              {chat.learningExcluded ? (
                <BrainCog className="h-3.5 w-3.5" />
              ) : (
                <Brain className="h-3.5 w-3.5" />
              )}
              {chat.learningExcluded ? 'Not learning' : 'Learning'}
            </button>
          </div>
        )}

        {showEmptyHero ? (
          /* Empty state: composed hero in the upper third, chips attached to
             the copy, composer waiting pinned below — no floating void. */
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[1140px] flex-col items-center px-6 pt-[16vh] text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft">
                <Sparkles className="h-6 w-6 text-accent" />
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-ink">
                Ask {ASSISTANT_SECTION_NAME} anything
              </h2>
              {brainStatus?.state === 'off' ? (
                <>
                  <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">
                    {ASSISTANT_SECTION_NAME} gets its edge from your Sales Brain — and it&rsquo;s
                    switched off right now. Turn it on in Settings → Sales Brain, and answers
                    here start citing your own calls, clients, and deals.
                  </p>
                  <p className="mt-3 text-[12.5px] text-faint">
                    You can still chat — answers just won&rsquo;t be grounded in your data yet.
                  </p>
                </>
              ) : brainStatus?.state === 'unavailable' ? (
                <>
                  <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">
                    {ASSISTANT_SECTION_NAME} can&rsquo;t reach your Sales Brain — it&rsquo;s on,
                    but its database didn&rsquo;t open this session, so nothing can be read or
                    learned until it does. Restarting the app usually fixes it.
                  </p>
                  <p className="mt-3 text-[12.5px] text-faint">
                    You can still chat — answers just won&rsquo;t be grounded in your data.
                    Importing more calls won&rsquo;t help while this persists.
                  </p>
                </>
              ) : brainStatus?.state === 'empty' ? (
                <>
                  <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">
                    {ASSISTANT_SECTION_NAME} gets its edge from your Sales Brain — and it&rsquo;s
                    empty right now. Import your call history or finish the Sales Brain interview
                    in Settings, then every answer here starts citing what it knows.
                  </p>
                  <p className="mt-3 text-[12.5px] text-faint">
                    You can still chat — answers just won&rsquo;t be grounded in your data yet.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">
                    Grounded in your Sales Brain — your calls, clients, deals, and selling
                    patterns. Every claim cites where it came from.
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
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
                </>
              )}
              <button
                type="button"
                onClick={() => setScopePickerOpen(true)}
                className="mt-5 flex items-center gap-1.5 rounded-full border border-accent/40 px-3.5 py-1.5 text-[12.5px] text-accent hover:bg-accent-soft"
              >
                <UserRound className="h-3.5 w-3.5" /> Talk about a specific client
              </button>
            </div>
          </div>
        ) : (
          <div
            ref={scrollRef}
            role="log"
            aria-label="Conversation"
            onScroll={() => {
              const el = scrollRef.current
              if (!el) return
              nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto w-full max-w-[1140px] space-y-4 px-6 py-5">
              {chat.loading && (
                <div className="space-y-3">
                  <SkeletonRows />
                </div>
              )}
              {!chat.loading && chat.messages.length === 0 && chat.scope && (
                /* A fresh scoped conversation: say who it's about, offer the
                   scoped prompts — one click sends. */
                <div className="rounded-2xl border border-line-soft bg-surface p-5">
                  <p className="text-[14px] font-semibold text-ink">
                    Talking about {chat.scope.contactName}
                    {chat.scope.company ? ` at ${chat.scope.company}` : ''}
                  </p>
                  <p className="mt-1 text-[12.5px] text-muted">
                    {ASSISTANT_SECTION_NAME} leads with their memories, calls, and deals here — and
                    never mixes in another client.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {scopedPrompts(chat.scope).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => void chat.send(p)}
                        className="rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-muted hover:border-accent/50 hover:text-ink"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {chat.messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  phase={chat.phase}
                  onCite={setCitation}
                  onApplySuggestion={(messageId, s) => void chat.applySuggestion(messageId, s)}
                  onConfirmTask={(messageId, proposalId) =>
                    void chat.confirmTask(messageId, proposalId)
                  }
                />
              ))}
            </div>
          </div>
        )}

        {/* Live-region for errors so screen readers hear them (audit H). */}
        <div aria-live="polite" className="shrink-0">
          {chat.error && (
            <div className="mx-auto mb-2 flex w-full max-w-[1140px] items-center justify-between rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
              <span className="whitespace-pre-wrap">{chat.error}</span>
              <IconButton icon={X} label="Dismiss error" onClick={chat.clearError} />
            </div>
          )}
          {notice && (
            <div className="mx-auto mb-2 flex w-full max-w-[1140px] items-center justify-between rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
              <span>{notice}</span>
              <IconButton icon={X} label="Dismiss notice" onClick={() => setNotice(null)} />
            </div>
          )}
        </div>

        {/* THE composer: one deliberate object — field and controls inside a
            single bordered surface; recording/transcribing/pending are states
            of the same object, not boxes around it. */}
        <div className="shrink-0 px-6 pb-5 pt-1">
          <div className="mx-auto w-full max-w-[1140px]">
            {voice.error && (
              <div
                aria-live="polite"
                className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-1.5 text-[12px] text-warning"
              >
                <span>{voice.error}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {voice.canRetry && (
                    <Button size="sm" variant="secondary" onClick={() => void voice.retryTranscribe()}>
                      Retry
                    </Button>
                  )}
                  <IconButton icon={X} label="Dismiss" onClick={voice.clearError} />
                </span>
              </div>
            )}
            <div className="rounded-2xl border border-line bg-surface shadow-card focus-within:border-accent/50">
              {pendingFiles.length > 0 && (
                /* M28 Part 3 — the send preview: exactly what each file will
                   contribute, before anything leaves the machine. */
                <div className="flex flex-wrap gap-2 border-b border-line-soft px-3 py-2">
                  {pendingFiles.map((p) => (
                    <AttachmentChip
                      key={p.attachment.id}
                      attachment={p.attachment}
                      preview={p.preview}
                      onRemove={() => removePendingFile(p.attachment.id)}
                    />
                  ))}
                </div>
              )}
              {voice.pending && (
                <div className="flex items-center justify-between border-b border-line-soft px-3 py-1.5 text-[12px] text-muted">
                  <span className="flex items-center gap-1.5">
                    <Mic className="h-3.5 w-3.5" /> Voice note attached ·{' '}
                    {formatDuration(voice.pending.durationMs)} — transcribed by Deepgram; review
                    the text, then send.
                  </span>
                  <IconButton icon={Trash2} label="Discard voice note" onClick={voice.discardPending} />
                </div>
              )}
              {/* AUDIT FIX (2026-08-25) — voice-note audio is POSTed to
                  Deepgram's prerecorded REST API, and NOTHING in Rise said so.
                  A consent and transparency gap, not a polish item: the user
                  is recording their own voice, and where it goes is a fact
                  they are entitled to before they finish, not after.
                  Disclosed at BOTH decision points — while recording (they
                  can still Cancel) and on the review chip (they can still
                  Discard) — because a disclosure only shown after the upload
                  would be a notice, not a choice. */}
              {voice.state === 'recording' && (
                <div className="border-b border-line-soft px-3 py-1.5 text-[11px] text-faint">
                  Audio is sent to Deepgram to be transcribed. Nothing is sent until you press
                  Done, and Cancel discards the recording without uploading it.
                </div>
              )}
              {voice.state === 'recording' ? (
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
                  </span>
                  <span className="text-[13px] tabular-nums text-ink" role="timer">
                    {formatDuration(voice.elapsedMs)}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
                    <div
                      className="h-full rounded-full bg-danger transition-[width] duration-100"
                      style={{ width: `${Math.round(voice.level * 100)}%` }}
                    />
                  </div>
                  <Button variant="secondary" size="sm" icon={X} onClick={voice.cancelRecording}>
                    Cancel
                  </Button>
                  <Button size="sm" icon={Check} onClick={() => void voice.finishRecording()}>
                    Done
                  </Button>
                </div>
              ) : (
                <>
                  <textarea
                    ref={textareaRef}
                    rows={Math.min(6, Math.max(1, draft.split('\n').length))}
                    className="block w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-faint"
                    placeholder={`Message ${ASSISTANT_SECTION_NAME}…`}
                    aria-label={`Message ${ASSISTANT_SECTION_NAME}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void handleSend()
                      }
                    }}
                  />
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <div className="flex items-center gap-0.5">
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.txt,.md,.csv"
                        className="hidden"
                        onChange={(e) => {
                          void addFiles(e.target.files)
                          e.target.value = ''
                        }}
                      />
                      <IconButton
                        icon={Paperclip}
                        label="Attach a file (images, PDF, DOCX, TXT, MD, CSV)"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={chat.sending}
                      />
                      {voice.state === 'transcribing' ? (
                        <span className="flex items-center gap-1.5 px-2 text-[12px] text-muted">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Transcribing with
                          Deepgram…
                        </span>
                      ) : (
                        <IconButton
                          icon={Mic}
                          label="Record a voice note"
                          onClick={() => void voice.start()}
                          disabled={chat.sending}
                        />
                      )}
                    </div>
                    {chat.sending ? (
                      <Button variant="secondary" size="sm" icon={Square} onClick={() => void chat.stop()}>
                        Stop
                      </Button>
                    ) : (
                      <Button size="sm" icon={Send} onClick={() => void handleSend()} disabled={!draft.trim()}>
                        Send
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {citation && (
        <EvidenceModal citation={citation} onClose={() => setCitation(null)} onOpenCall={onOpenCall} />
      )}
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
      {scopePickerOpen && (
        <ScopePickerModal
          onClose={() => setScopePickerOpen(false)}
          onPick={(scope) => {
            setScopePickerOpen(false)
            void startConversation(undefined, undefined, undefined, scope)
          }}
        />
      )}
    </div>
  )
}
