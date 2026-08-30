import { useEffect, useRef, useState } from 'react'
import {
  Send,
  Sparkles,
  MessageSquare,
  Drama,
  LogOut,
  Mail,
  ListPlus,
  NotebookPen,
  Check,
  X,
  Loader2
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { useCoachChat, type DisplayMessage } from './useCoachChat'
import {
  CONTEXT_SUGGESTION_LABEL,
  type CoachChatContextSuggestion,
  type CoachChatMessage,
  type CoachChatMode,
  type CoachChatTaskProposal
} from './types'

interface CoachChatPanelProps {
  callId: string
  initialMessages: CoachChatMessage[]
  hasContact: boolean
}

function Bubble({
  message,
  onApplySuggestion
}: {
  message: DisplayMessage
  onApplySuggestion: (s: CoachChatContextSuggestion) => void
}): React.JSX.Element {
  const isUser = message.role === 'user'
  const isPractice = message.mode === 'practice'

  return (
    <div className={cn('flex flex-col gap-1.5', isUser ? 'items-end' : 'items-start')}>
      {isPractice && (
        <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-warning">
          {isUser ? 'You (practicing)' : 'Playing the buyer'}
        </span>
      )}
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap',
          isUser
            ? 'bg-accent-fill text-on-accent'
            : isPractice
              ? 'border border-warning/30 bg-warning-soft text-ink'
              : 'border border-line-soft bg-canvas text-ink'
        )}
      >
        {message.text || (message.streaming ? '…' : '')}
        {message.streaming && message.text && (
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle" />
        )}
      </div>
      {message.suggestions && message.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.suggestions.map((s) => {
            const applied = message.appliedSuggestionIds?.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                disabled={applied}
                onClick={() => onApplySuggestion(s)}
                title={s.text}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
                  applied
                    ? 'cursor-default border-positive/30 bg-positive-soft text-positive'
                    : 'border-line text-muted hover:border-accent hover:text-accent'
                )}
              >
                {applied ? <Check className="h-3 w-3" /> : null}
                {applied ? 'Saved' : CONTEXT_SUGGESTION_LABEL[s.type]}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TaskProposalCard({
  proposal,
  onAccept,
  onReject
}: {
  proposal: CoachChatTaskProposal
  onAccept: () => void
  onReject: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{proposal.title}</p>
        <p className="text-[11px] text-faint">
          {proposal.type} · {proposal.priority} priority
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="secondary" icon={X} onClick={onReject}>
          Skip
        </Button>
        <Button size="sm" icon={Check} onClick={onAccept}>
          Add task
        </Button>
      </div>
    </div>
  )
}

function CrmNoteCard({
  note,
  onAccept,
  onReject
}: {
  note: string
  onAccept: () => void
  onReject: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent-soft p-3.5">
      <p className="whitespace-pre-wrap text-[13px] text-ink">{note}</p>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <Button size="sm" variant="secondary" icon={X} onClick={onReject}>
          Discard
        </Button>
        <Button size="sm" icon={Check} onClick={onAccept}>
          Save to contact
        </Button>
      </div>
    </div>
  )
}

const MODE_OPTIONS: { id: CoachChatMode; label: string }[] = [
  { id: 'advisor', label: 'Advisor' },
  { id: 'practice', label: 'Practice' }
]

/** M23 Workstream B — chat with full call context (advisor Q&A) and a
 *  practice/roleplay toggle. Renders inside CallDetail's "Ask your coach"
 *  card. */
export function CoachChatPanel({
  callId,
  initialMessages,
  hasContact
}: CoachChatPanelProps): React.JSX.Element {
  const chat = useCoachChat(callId, initialMessages)
  const [input, setInput] = useState('')
  const [taskProposal, setTaskProposal] = useState<CoachChatTaskProposal | null>(null)
  const [crmNoteDraft, setCrmNoteDraft] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<'task' | 'note' | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [chat.messages, taskProposal, crmNoteDraft])

  const submit = (): void => {
    const text = input
    setInput('')
    void chat.send(text)
  }

  const onProposeTask = async (): Promise<void> => {
    setActionBusy('task')
    setTaskProposal(null)
    const proposal = await chat.proposeTask()
    setActionBusy(null)
    if (proposal) setTaskProposal(proposal)
  }

  const onRegenerateNote = async (): Promise<void> => {
    setActionBusy('note')
    setCrmNoteDraft(null)
    const note = await chat.regenerateCrmNote()
    setActionBusy(null)
    if (note) setCrmNoteDraft(note)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SegmentedControl
          options={MODE_OPTIONS}
          value={chat.mode}
          disabled={chat.sending}
          onChange={(next) => chat.setMode(next)}
        />
        {chat.mode === 'practice' && (
          <Button
            variant="secondary"
            size="sm"
            icon={LogOut}
            onClick={() => void chat.endPractice()}
            disabled={chat.sending}
          >
            End practice
          </Button>
        )}
      </div>

      {chat.mode === 'practice' && chat.messages.every((m) => m.mode !== 'practice') && (
        <p className="rounded-xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[12px] text-ink">
          Practice mode: the coach will play the BUYER from this call, using their tone and
          objections. Rehearse your opening, pricing conversation, or objection handling, then click{' '}
          <strong>End practice</strong> (or type it) for feedback.
        </p>
      )}

      <div
        ref={scrollRef}
        className="flex max-h-[420px] min-h-[160px] flex-col gap-3 overflow-y-auto rounded-2xl border border-line-soft bg-surface p-3.5"
      >
        {chat.messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center text-muted">
            <MessageSquare className="h-5 w-5 text-faint" />
            <p className="text-[13px]">
              Ask anything about this call — or switch to Practice to rehearse.
            </p>
          </div>
        ) : (
          chat.messages.map((m) => (
            <Bubble
              key={m.id}
              message={m}
              onApplySuggestion={(s) => void chat.applySuggestion(m.id, s)}
            />
          ))
        )}
        {taskProposal && (
          <TaskProposalCard
            proposal={taskProposal}
            onReject={() => setTaskProposal(null)}
            onAccept={() => {
              // Only dismiss the card on confirmed success — on failure,
              // chat.confirmTask() already surfaces chat.error, and leaving
              // the card up lets the rep retry instead of losing the
              // proposal silently.
              void (async () => {
                const ok = await chat.confirmTask(taskProposal)
                if (ok) setTaskProposal(null)
              })()
            }}
          />
        )}
        {crmNoteDraft && (
          <CrmNoteCard
            note={crmNoteDraft}
            onReject={() => setCrmNoteDraft(null)}
            onAccept={() => {
              void (async () => {
                const ok = await chat.saveCrmNote(crmNoteDraft)
                if (ok) setCrmNoteDraft(null)
              })()
            }}
          />
        )}
      </div>

      {chat.error && <p className="text-[12px] text-danger">{chat.error}</p>}

      {chat.mode === 'advisor' && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            icon={Mail}
            onClick={() => void chat.draftFollowUpEmail()}
            disabled={chat.sending}
          >
            Draft follow-up email
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={actionBusy === 'task' ? Loader2 : ListPlus}
            onClick={() => void onProposeTask()}
            disabled={chat.sending || actionBusy !== null}
          >
            Add task
          </Button>
          {hasContact && (
            <Button
              variant="secondary"
              size="sm"
              icon={actionBusy === 'note' ? Loader2 : NotebookPen}
              onClick={() => void onRegenerateNote()}
              disabled={chat.sending || actionBusy !== null}
            >
              Regenerate CRM note
            </Button>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={
            chat.mode === 'practice'
              ? 'Say your line to the buyer…'
              : 'Ask your coach anything about this call…'
          }
          rows={2}
          disabled={chat.sending}
          className="flex-1 resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent disabled:opacity-60"
        />
        <Button
          icon={chat.sending ? Loader2 : Send}
          onClick={submit}
          disabled={chat.sending || !input.trim()}
          className={chat.sending ? '[&_svg]:animate-spin' : ''}
        >
          Send
        </Button>
      </div>
    </div>
  )
}

/** Wraps CoachChatPanel in the Card shell CallDetail.tsx expects, matching
 *  the existing "Sales coaching" card's header pattern. */
export function CoachChatCard({
  callId,
  initialMessages,
  hasContact
}: CoachChatPanelProps): React.JSX.Element {
  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">Ask your coach</h3>
        <span title="Practice mode available">
          <Drama className="ml-1 h-3.5 w-3.5 text-faint" />
        </span>
      </div>
      <CoachChatPanel callId={callId} initialMessages={initialMessages} hasContact={hasContact} />
    </Card>
  )
}
