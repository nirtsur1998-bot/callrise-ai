import { useEffect, useMemo, useState } from 'react'
import {
  Building2,
  Mail,
  Phone,
  Hash,
  CalendarClock,
  PhoneCall,
  Pencil,
  GraduationCap,
  AlertTriangle,
  ListPlus,
  CheckCircle2,
  History,
  MessageSquare,
  Sparkles,
  Trash2,
  NotebookPen
} from 'lucide-react'
import { EmptyState } from '@renderer/components/EmptyState'
import { flagEmoji, countryDial, countryName } from '@renderer/lib/countries'
import { TONE_TO_GAUGE, overallTier } from '@renderer/features/coaching/meta'
import { ScoreGauge } from '@renderer/components/ScoreGauge'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { BackButton } from '@renderer/components/BackButton'
import { StatCard } from '@renderer/components/StatCard'
import { Badge } from '@renderer/components/Badge'
import { fieldClass } from '@renderer/components/field'
import { cn } from '@renderer/lib/cn'
import { isContactStale, createContactFollowUpTask } from '@renderer/features/deals/staleness'
import { useDeals } from '@renderer/features/deals/useDeals'
import { useDealStages } from '@renderer/features/deals/useDealStages'
import { recordRecentlyViewed } from '@renderer/lib/recentlyViewed'
import { useContactCallHistory } from './useContactCallHistory'
import { CallHistoryList } from './CallHistoryList'
import { ContactTimeline } from './ContactTimeline'
import { CrmNoteGeneratorCard } from './CrmNoteGeneratorCard'
import { formatRelative } from './contactStats'
import type { Contact, ContactComment } from './types'
import { formatDateOnly } from '@renderer/lib/dateOnly'
import { openAssistantFor } from '@renderer/features/assistant/assistantNav'
import { ASSISTANT_SECTION_NAME } from '@renderer/features/assistant/config'

interface ContactDetailProps {
  contact: Contact
  hasOpenDeal: boolean
  staleFollowUpEnabled: boolean
  staleAfterDays: number
  /** M23 Workstream C — Settings → CRM → "CRM Note Generator". Off (default)
   *  renders this page exactly as it was before that workstream. */
  noteGeneratorEnabled: boolean
  /** Re-fetches the contacts list — passed through to CrmNoteGeneratorCard
   *  so a saved note / applied KYC update shows up immediately. */
  onContactUpdated: () => void
  onBack: () => void
  onEdit: () => void
}

/** The payoff view: everything linked to one person, chronologically — their
 *  calls, each with its summary, key objections (from coaching), and tasks. */
export function ContactDetail({
  contact,
  hasOpenDeal,
  staleFollowUpEnabled,
  staleAfterDays,
  noteGeneratorEnabled,
  onContactUpdated,
  onBack,
  onEdit
}: ContactDetailProps): React.JSX.Element {
  const { loading, linked } = useContactCallHistory(contact.id)
  const { deals } = useDeals()
  const { stages } = useDealStages()
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskCreated, setTaskCreated] = useState(false)
  const [comments, setComments] = useState<ContactComment[]>(contact.comments ?? [])
  const [commentDraft, setCommentDraft] = useState('')
  const [postingComment, setPostingComment] = useState(false)

  // Re-sync the locally-tracked comment list whenever a fresh contact record
  // arrives (e.g. the parent refetches after an unrelated edit) — adjusted
  // during render (React's recommended pattern for "reset state when a prop
  // changes") rather than an effect, so it can't cause an extra render pass.
  const [syncedContact, setSyncedContact] = useState(contact)
  if (syncedContact.id !== contact.id || syncedContact.comments !== contact.comments) {
    setSyncedContact(contact)
    setComments(contact.comments ?? [])
  }

  useEffect(() => {
    recordRecentlyViewed('contact', contact.id, contact.name)
  }, [contact.id, contact.name])

  const postComment = async (): Promise<void> => {
    const text = commentDraft.trim()
    if (!text) return
    setPostingComment(true)
    try {
      const updated = await window.api.contacts.addComment(contact.id, text)
      if (updated) {
        setComments(updated.comments ?? [])
        setCommentDraft('')
      }
    } finally {
      setPostingComment(false)
    }
  }

  const deleteComment = async (commentId: string): Promise<void> => {
    const updated = await window.api.contacts.removeComment(contact.id, commentId)
    if (updated) setComments(updated.comments ?? [])
  }

  const registered = formatRegisteredDate(contact.registeredAt)
  const dial = countryDial(contact.phoneCountry)
  const stale =
    !loading &&
    isContactStale(
      hasOpenDeal,
      linked[0]?.call.createdAt,
      staleFollowUpEnabled,
      staleAfterDays,
      contact.createdAt
    )

  const handleCreateFollowUpTask = async (): Promise<void> => {
    setCreatingTask(true)
    try {
      await createContactFollowUpTask(contact.id, contact.name)
      setTaskCreated(true)
    } catch {
      /* button stays visible for a retry */
    } finally {
      setCreatingTask(false)
    }
  }

  const avgScore = useMemo(() => {
    const scores = linked
      .map((l) => l.call.coaching?.overallScore)
      .filter((s): s is number => typeof s === 'number')
    if (!scores.length) return null
    return Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length)
  }, [linked])

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between">
        <BackButton onClick={onBack} label="Contacts" />
        <div className="flex items-center gap-2">
          {/* M28 Part 4 — open the assistant scoped to this client. */}
          <Button
            variant="secondary"
            size="sm"
            icon={Sparkles}
            onClick={() =>
              openAssistantFor({
                contactId: contact.id,
                contactName: contact.name,
                company: contact.company
              })
            }
          >
            Ask {ASSISTANT_SECTION_NAME}
          </Button>
          <Button variant="secondary" size="sm" icon={Pencil} onClick={onEdit}>
            Edit
          </Button>
        </div>
      </div>

      {/* Contact header */}
      <div className="mb-4 flex items-start gap-4 rounded-2xl border border-line-soft bg-surface p-6">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent-soft text-lg font-semibold text-accent">
          {contact.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {contact.country && (
              <span title={countryName(contact.country)}>{flagEmoji(contact.country)}</span>
            )}
            {contact.name}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
            {contact.company && (
              <span className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" /> {contact.company}
              </span>
            )}
            {contact.cid && (
              <span className="flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5" /> {contact.cid}
              </span>
            )}
            {contact.email && (
              <a
                href={`mailto:${contact.email}`}
                className="flex items-center gap-1.5 hover:text-accent hover:underline"
              >
                <Mail className="h-3.5 w-3.5" /> {contact.email}
              </a>
            )}
            {contact.phone && (
              <a
                href={`tel:${contact.phone}`}
                className="flex items-center gap-1.5 hover:text-accent hover:underline"
              >
                <Phone className="h-3.5 w-3.5" /> {dial ? `${dial} ` : ''}
                {contact.phone}
              </a>
            )}
            {registered && (
              <span className="flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5" /> Customer since {registered}
              </span>
            )}
          </div>
          {contact.notes && (
            <p className="mt-3 text-sm whitespace-pre-line text-muted">{contact.notes}</p>
          )}
        </div>
      </div>

      {stale && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <p className="text-[13px] text-ink">
              No calls with {contact.name} in over {staleAfterDays} days — may need a follow-up.
            </p>
          </div>
          {taskCreated ? (
            <span className="shrink-0 flex items-center gap-1 text-[13px] font-medium text-positive">
              <CheckCircle2 className="h-3.5 w-3.5" /> Task created — see Tasks.
            </span>
          ) : (
            <Button
              size="sm"
              icon={ListPlus}
              onClick={() => void handleCreateFollowUpTask()}
              disabled={creatingTask}
              className="shrink-0"
            >
              {creatingTask ? 'Creating…' : 'Create follow-up task'}
            </Button>
          )}
        </div>
      )}

      {/* Quick stats — the "so what" glance before diving into individual calls */}
      {!loading && linked.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <StatCard icon={PhoneCall} label="Calls" value={String(linked.length)} />
          <StatCard
            icon={CalendarClock}
            label="Last contact"
            value={formatRelative(linked[0].call.createdAt)}
          />
          <div className="flex items-center gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
              <GraduationCap className="h-3 w-3" /> Avg. coach score
            </p>
            {avgScore !== null ? (
              <ScoreGauge
                score={avgScore}
                size={48}
                tone={TONE_TO_GAUGE[overallTier(avgScore).tone]}
              />
            ) : (
              <span className="text-lg font-semibold text-faint">—</span>
            )}
          </div>
        </div>
      )}

      {/* M23 Workstream C — the standalone note generator.
          M31 Stage 3: it used to be hidden entirely when off ("Hidden
          entirely when off", as the comment here said in as many words),
          which is the 50%-invisible problem stated by the code itself. */}
      {noteGeneratorEnabled ? (
        <CrmNoteGeneratorCard contactId={contact.id} onContactUpdated={onContactUpdated} />
      ) : (
        <div className="mb-4 rounded-2xl border border-line-soft bg-surface p-5">
          <EmptyState
            compact
            icon={NotebookPen}
            title="Note drafting is switched off"
            reason={{
              kind: 'off',
              settingsPage: 'crm',
              what: 'Turns this contact’s most recent call into a written CRM note at the length you pick, and pulls out facts worth keeping on their record — job title, budget, timeline — for you to accept or reject one at a time.',
              cost: 'Makes one AI call per draft. Nothing is saved to the contact until you confirm it.',
              actionLabel: 'Turn on note drafting'
            }}
          />
        </div>
      )}

      {/* Comments — the rep's own notes, plus any AI-drafted ones (opt-in,
          Settings → CRM → "Auto-generate notes") appended after a linked call. */}
      <div className="mb-4 rounded-2xl border border-line-soft bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Comments</h3>
          {comments.length > 0 && <span className="text-[11px] text-faint">{comments.length}</span>}
        </div>

        <div className="mb-3 flex gap-2">
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="Leave a note about this client…"
            rows={2}
            className={cn(fieldClass, 'flex-1 resize-y')}
          />
          <Button
            size="sm"
            onClick={() => void postComment()}
            disabled={postingComment || !commentDraft.trim()}
            className="self-end"
          >
            {postingComment ? 'Posting…' : 'Post'}
          </Button>
        </div>

        {comments.length === 0 ? (
          <p className="text-[13px] text-faint">No comments yet.</p>
        ) : (
          <ul className="space-y-2.5">
            {[...comments]
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((c) => (
                <li
                  key={c.id}
                  className="group flex items-start gap-2 rounded-xl border border-line-soft bg-canvas px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      {c.source === 'ai' && (
                        <Badge tone="accent" icon={Sparkles}>
                          AI-drafted
                        </Badge>
                      )}
                      <span className="text-[11px] text-faint">{formatRelative(c.createdAt)}</span>
                    </div>
                    <p className="text-[13px] whitespace-pre-line text-ink">{c.text}</p>
                  </div>
                  <IconButton
                    icon={Trash2}
                    label="Delete comment"
                    variant="danger"
                    onClick={() => void deleteComment(c.id)}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  />
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* Call history */}
      <div className="flex-1 overflow-y-auto pb-2">
        <div className="mb-3 flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Call history</h3>
          {!loading && <span className="text-[11px] text-faint">{linked.length}</span>}
        </div>

        <CallHistoryList
          loading={loading}
          linked={linked}
          emptyMessage={`No calls linked to ${contact.name} yet. Open a saved call and link it here.`}
        />

        {/* Timeline — calls, deal stage moves, and tasks, merged chronologically */}
        <div className="mt-6 mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Timeline</h3>
        </div>

        {loading ? (
          <p className="text-[13px] text-faint">Loading…</p>
        ) : (
          <ContactTimeline contactId={contact.id} linked={linked} deals={deals} stages={stages} />
        )}
      </div>
    </div>
  )
}

// registeredAt is DATE-ONLY — formatDateOnly avoids the UTC-midnight parse
// that displayed the previous day for users west of UTC.
const formatRegisteredDate = formatDateOnly
