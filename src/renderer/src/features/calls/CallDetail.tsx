import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Trash2,
  Clock,
  Users,
  Sparkles,
  Paperclip,
  Plus,
  FileText,
  RotateCw,
  ListChecks,
  GraduationCap,
  Contact as ContactIcon
} from 'lucide-react'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import { SummaryView, SummaryLoading } from '@renderer/components/SummaryView'
import { GenerateTasksDialog } from '@renderer/features/tasks/GenerateTasksDialog'
import { CoachReportView, CoachLoading } from '@renderer/features/coaching/CoachReportView'
import { useContacts } from '@renderer/features/contacts/useContacts'
import { ContactPicker } from '@renderer/features/contacts/ContactPicker'
import { CalendarMatchSuggestion } from '@renderer/features/contacts/CalendarMatchSuggestion'
import {
  findCalendarMatches,
  isMatchDismissed,
  dismissMatch,
  matchSensitivityMs,
  type CalendarMatch
} from '@renderer/features/contacts/calendarMatch'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import { formatDate, formatDuration, formatBytes } from './format'
import type { Attachment, Call } from './types'

const ACCEPT = '.pdf,.txt,.md,.docx'
const SUPPORTED = ['pdf', 'txt', 'md', 'docx']
const MAX_FILE_BYTES = 20 * 1024 * 1024

interface CallDetailProps {
  callId: string
  onBack: () => void
  onDeleted: () => void
  onChanged: () => void
}

export function CallDetail({
  callId,
  onBack,
  onDeleted,
  onChanged
}: CallDetailProps): React.JSX.Element {
  const [call, setCall] = useState<Call | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [noKey, setNoKey] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [tasksAdded, setTasksAdded] = useState(0)
  const [coaching, setCoaching] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)
  const { contacts, create: createContact } = useContacts()
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  const [matchDismissed, setMatchDismissed] = useState(() => isMatchDismissed(callId))
  const { settings } = useAppSettings()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const onDeletedRef = useRef(onDeleted)
  onDeletedRef.current = onDeleted

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    setCall(null)
    setMatchDismissed(isMatchDismissed(callId))
    void window.api.calls.get(callId).then((c) => {
      if (!active) return
      if (c) setCall(c)
      else onDeletedRef.current() // missing/corrupt — back to the list
    })
    return () => {
      active = false
    }
  }, [callId])

  useEffect(() => {
    // Read-only cache, no network pull — the calendar screen already keeps it
    // fresh; this just needs "what's already known" for the match suggestion.
    let active = true
    void window.api.google.cachedEvents().then((events) => {
      if (active) setGoogleEvents(events)
    })
    return () => {
      active = false
    }
  }, [])

  const reload = useCallback(async () => {
    const c = await window.api.calls.get(callId)
    if (mountedRef.current && c) setCall(c)
  }, [callId])

  const notifyChanged = useCallback(async () => {
    await reload()
    onChanged()
  }, [reload, onChanged])

  const summarizeCall = useCallback(async () => {
    setSummaryError(null)
    setNoKey(false)
    setSummarizing(true)
    try {
      const res = await window.api.calls.summarizeCall(callId)
      if (!mountedRef.current) return
      if (res.ok) await notifyChanged()
      else if (res.error === 'no-key') setNoKey(true)
      else setSummaryError(res.message ?? 'Could not generate the summary.')
    } catch {
      if (mountedRef.current) setSummaryError('Could not generate the summary. Please try again.')
    } finally {
      if (mountedRef.current) setSummarizing(false)
    }
  }, [callId, notifyChanged])

  const coachCall = useCallback(async () => {
    setCoachError(null)
    setNoKey(false)
    setCoaching(true)
    try {
      const res = await window.api.calls.coachCall(callId)
      if (!mountedRef.current) return
      if (res.ok) await notifyChanged()
      else if (res.error === 'no-key') setNoKey(true)
      else setCoachError(res.message ?? 'Could not coach this call.')
    } catch {
      if (mountedRef.current) setCoachError('Could not coach this call. Please try again.')
    } finally {
      if (mountedRef.current) setCoaching(false)
    }
  }, [callId, notifyChanged])

  const handleFile = useCallback(
    async (file: File) => {
      setAddError(null)
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!SUPPORTED.includes(ext)) {
        setAddError('Unsupported file type. Use PDF, .txt, .md, or .docx.')
        return
      }
      if (file.size > MAX_FILE_BYTES) {
        setAddError('That file is too large (max 20 MB).')
        return
      }
      setAdding(true)
      try {
        const data = await file.arrayBuffer()
        const res = await window.api.calls.addAttachment(callId, { name: file.name, ext, data })
        if (!mountedRef.current) return
        if (res.ok) await notifyChanged()
        else {
          setAddError(
            res.error === 'too-large'
              ? 'That file is too large (max 20 MB).'
              : res.error === 'empty'
                ? 'That file appears to be empty.'
                : res.error === 'unsupported-type'
                  ? "That file type isn't supported."
                  : 'Could not add that file.'
          )
        }
      } catch {
        if (mountedRef.current) setAddError('Could not read that file.')
      } finally {
        if (mountedRef.current) setAdding(false)
      }
    },
    [callId, notifyChanged]
  )

  const deleteCall = useCallback(async () => {
    await window.api.calls.delete(callId)
    onChanged()
    onDeleted()
  }, [callId, onChanged, onDeleted])

  const linkContact = useCallback(
    async (contactId: string | undefined) => {
      await window.api.calls.setContact(callId, contactId ?? null)
      await notifyChanged()
    },
    [callId, notifyChanged]
  )

  const createAndLinkAttendee = useCallback(
    async (attendee: CalendarMatch['attendee']) => {
      const contact = await createContact({
        name: attendee.name || attendee.email,
        email: attendee.email
      })
      if (contact) await linkContact(contact.id)
    },
    [createContact, linkContact]
  )

  const dismissMatchSuggestion = useCallback(() => {
    dismissMatch(callId)
    setMatchDismissed(true)
  }, [callId])

  if (!call) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
    )
  }

  const attachments = call.attachments ?? []
  const calendarMatches =
    !call.contactId && !matchDismissed && settings.crm.calendarMatchEnabled
      ? findCalendarMatches(call, googleEvents, matchSensitivityMs(settings.crm.matchSensitivity))
      : []

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-muted transition hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Past Calls
        </button>
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={deleteCall}
              className="rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
            >
              Delete call
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:border-rose-500/40 hover:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        )}
      </div>

      {/* Title + meta */}
      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">{call.title}</h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-4 text-[13px] text-muted">
          <span>{formatDate(call.createdAt)}</span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {formatDuration(call.durationMs)}
          </span>
          <span className="flex items-center gap-1">
            <Users className="h-3.5 w-3.5" /> {call.speakerCount} speaker
            {call.speakerCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 space-y-4 overflow-y-auto pb-2">
        {noKey && <NoKeyBanner />}

        {/* Linked contact */}
        <section className="rounded-2xl border border-line-soft bg-surface p-6">
          <div className="mb-3 flex items-center gap-2">
            <ContactIcon className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Contact</h3>
          </div>
          {calendarMatches.length > 0 && (
            <div className="mb-3">
              <CalendarMatchSuggestion
                matches={calendarMatches}
                contacts={contacts}
                onLink={(contactId) => void linkContact(contactId)}
                onCreateAndLink={(attendee) => void createAndLinkAttendee(attendee)}
                onDismiss={dismissMatchSuggestion}
              />
            </div>
          )}
          <ContactPicker
            value={call.contactId}
            contacts={contacts}
            onSelect={(contactId) => void linkContact(contactId)}
            onCreate={createContact}
          />
        </section>

        {/* AI summary */}
        <section className="rounded-2xl border border-line-soft bg-surface p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">AI summary</h3>
            </div>
            {call.summary && !summarizing && (
              <button
                type="button"
                onClick={summarizeCall}
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
              >
                <RotateCw className="h-3.5 w-3.5" /> Regenerate
              </button>
            )}
          </div>
          {summarizing ? (
            <SummaryLoading />
          ) : call.summary ? (
            <SummaryView summary={call.summary} />
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">
                Generate a concise summary of this call — executive summary, key points, action
                items, and any questions or objections.
              </p>
              {summaryError && <p className="text-[13px] text-rose-300">{summaryError}</p>}
              <button
                type="button"
                onClick={summarizeCall}
                className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
              >
                <Sparkles className="h-4 w-4" /> Summarize
              </button>
            </div>
          )}
        </section>

        {/* Sales coaching */}
        <section className="rounded-2xl border border-line-soft bg-surface p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GraduationCap className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">Sales coaching</h3>
            </div>
            {call.coaching && !coaching && (
              <button
                type="button"
                onClick={coachCall}
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
              >
                <RotateCw className="h-3.5 w-3.5" /> Re-coach
              </button>
            )}
          </div>
          {coaching ? (
            <CoachLoading />
          ) : call.coaching ? (
            <CoachReportView report={call.coaching} callId={callId} callTitle={call.title} />
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">
                Get an evidence-based scorecard for this call — six coaching dimensions scored 1–5
                with quotes from the transcript, your talk-time metrics, your top two things to
                improve, and one concrete thing to try on your next call.
              </p>
              {coachError && <p className="text-[13px] text-rose-300">{coachError}</p>}
              <button
                type="button"
                onClick={coachCall}
                className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
              >
                <GraduationCap className="h-4 w-4" /> Coach this call
              </button>
            </div>
          )}
        </section>

        {/* Tasks */}
        <section className="rounded-2xl border border-line-soft bg-surface p-6">
          <div className="mb-4 flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Tasks</h3>
          </div>
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted">
              Let Claude suggest action items from this call — follow-ups, emails to send, meetings
              to book, and research to do. You&apos;ll review and edit them before anything is
              saved.{' '}
              <span className="text-faint">
                These are reminders only; the app won&apos;t send or schedule anything.
              </span>
            </p>
            {tasksAdded > 0 && (
              <p className="text-[13px] text-emerald-300">
                Added {tasksAdded} {tasksAdded === 1 ? 'task' : 'tasks'} — find them in the Tasks
                tab.
              </p>
            )}
            <button
              type="button"
              onClick={() => setShowTasks(true)}
              className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
            >
              <ListChecks className="h-4 w-4" /> Generate tasks
            </button>
          </div>
        </section>

        {/* Files */}
        <section className="rounded-2xl border border-line-soft bg-surface p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-faint" />
              <h3 className="text-sm font-semibold">Files</h3>
              {attachments.length > 0 && (
                <span className="text-[11px] text-faint">{attachments.length}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={adding}
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> {adding ? 'Adding…' : 'Add file'}
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = '' // allow re-selecting the same file
              if (f) void handleFile(f)
            }}
          />
          {addError && <p className="mb-3 text-[13px] text-rose-300">{addError}</p>}
          {attachments.length === 0 ? (
            <p className="text-sm text-faint">
              No files yet. Add a PDF, .txt, .md, or .docx and summarize it.
            </p>
          ) : (
            <div className="space-y-3">
              {attachments.map((att) => (
                <AttachmentCard
                  key={att.id}
                  callId={callId}
                  attachment={att}
                  onChanged={notifyChanged}
                  onNoKey={() => setNoKey(true)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Transcript */}
        <section className="rounded-2xl border border-line-soft bg-surface px-7 py-6">
          <h3 className="mb-4 text-sm font-semibold">Transcript</h3>
          {call.segments.length > 0 ? (
            <SpeakerTranscript segments={call.segments} />
          ) : (
            <p className="text-sm text-faint">This call has no transcript.</p>
          )}
        </section>
      </div>

      {showTasks && (
        <GenerateTasksDialog
          callId={callId}
          callTitle={call.title}
          onClose={() => setShowTasks(false)}
          onSaved={(count) => {
            setTasksAdded(count)
            setShowTasks(false)
          }}
        />
      )}
    </div>
  )
}

function NoKeyBanner(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
      <p className="font-medium">Add your Anthropic API key</p>
      <p className="mt-1 text-amber-200/80">
        AI summaries need an Anthropic key. Get one at console.anthropic.com, paste it into the
        <code className="mx-1 rounded bg-canvas px-1 py-0.5 text-amber-100">.env</code> file as
        <code className="mx-1 rounded bg-canvas px-1 py-0.5 text-amber-100">
          ANTHROPIC_API_KEY=…
        </code>
        , then restart the app.
      </p>
    </div>
  )
}

interface AttachmentCardProps {
  callId: string
  attachment: Attachment
  onChanged: () => Promise<void> | void
  onNoKey: () => void
}

function AttachmentCard({
  callId,
  attachment,
  onChanged,
  onNoKey
}: AttachmentCardProps): React.JSX.Element {
  const [summarizing, setSummarizing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Clear transient state when this attachment changes (e.g. after a reload).
  useEffect(() => {
    setError(null)
    setConfirmRemove(false)
  }, [attachment.id, attachment.summary])

  const summarize = async (): Promise<void> => {
    setError(null)
    setSummarizing(true)
    try {
      const res = await window.api.calls.summarizeAttachment(callId, attachment.id)
      if (!mountedRef.current) return
      if (res.ok) await onChanged()
      else if (res.error === 'no-key') onNoKey()
      else setError(res.message ?? 'Could not summarize this file.')
    } catch {
      if (mountedRef.current) setError('Could not summarize this file. Please try again.')
    } finally {
      if (mountedRef.current) setSummarizing(false)
    }
  }

  const remove = async (): Promise<void> => {
    setConfirmRemove(false)
    const res = await window.api.calls.removeAttachment(callId, attachment.id)
    if (res.ok) await onChanged()
    else if (mountedRef.current) setError('Could not remove that file. Please try again.')
  }

  return (
    <div className="rounded-xl border border-line-soft bg-canvas p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-elevated">
          <FileText className="h-4 w-4 text-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{attachment.name}</p>
          <p className="text-[11px] text-faint">
            {attachment.ext.toUpperCase()} · {formatBytes(attachment.sizeBytes)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!summarizing && (
            <button
              type="button"
              onClick={summarize}
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              <Sparkles className="h-3.5 w-3.5" /> {attachment.summary ? 'Regenerate' : 'Summarize'}
            </button>
          )}
          {confirmRemove ? (
            <>
              <button
                type="button"
                onClick={remove}
                className="rounded-lg bg-rose-500/20 px-2 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="rounded-lg border border-line px-2 py-1.5 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              title="Remove file"
              className="grid h-8 w-8 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-rose-300"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-[13px] text-rose-300">{error}</p>}
      {summarizing ? (
        <div className="mt-4">
          <SummaryLoading label="Summarizing file with Claude…" />
        </div>
      ) : attachment.summary ? (
        <div className="mt-4 border-t border-line-soft pt-4">
          <SummaryView summary={attachment.summary} />
        </div>
      ) : null}
    </div>
  )
}
