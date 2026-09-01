import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Trash2,
  Clock,
  Users,
  Sparkles,
  Paperclip,
  Plus,
  FileText,
  RotateCw,
  RefreshCw,
  ListChecks,
  GraduationCap,
  Contact as ContactIcon,
  Copy,
  Check,
  Search,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Bookmark as BookmarkIcon,
  ClipboardList,
  Radar,
  UserSearch,
  Loader2
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { ScrollToEnd } from '@renderer/components/ScrollToEnd'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import { SummaryView, SummaryLoading } from '@renderer/components/SummaryView'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import { BackButton } from '@renderer/components/BackButton'
import { Card } from '@renderer/components/Card'
import { EmptyState } from '@renderer/components/EmptyState'
import { Skeleton } from '@renderer/components/Skeleton'
import { fieldClass } from '@renderer/components/field'
import { overallTier, TONE_TO_BADGE, speakerLabel } from '@renderer/features/coaching/meta'
import { openAssistantFor } from '@renderer/features/assistant/assistantNav'
import { ASSISTANT_SECTION_NAME } from '@renderer/features/assistant/config'
import { Badge } from '@renderer/components/Badge'
import { GenerateTasksDialog } from '@renderer/features/tasks/GenerateTasksDialog'
import { CoachReportView, CoachLoading } from '@renderer/features/coaching/CoachReportView'
import { CoachChatCard } from '@renderer/features/coaching/CoachChatPanel'
import { MineTestPanel } from '@renderer/features/objection-library/MineTestPanel'
import { useJobByTarget } from '@renderer/features/jobs/useJobByTarget'
import { useContacts } from '@renderer/features/contacts/useContacts'
import { ContactPicker } from '@renderer/features/contacts/ContactPicker'
import { CallDealPicker } from './CallDealPicker'
import {
  CalendarMatchSuggestion,
  AutoLinkedNotice
} from '@renderer/features/contacts/CalendarMatchSuggestion'
import { IdentityContactSuggestion } from './IdentityContactSuggestion'
import {
  isIdentitySuggestionDismissed,
  dismissIdentitySuggestion
} from './identitySuggestionDismiss'
import {
  findCalendarMatches,
  isMatchDismissed,
  dismissMatch,
  matchSensitivityMs,
  type CalendarMatch
} from '@renderer/features/contacts/calendarMatch'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import { SalesBrainCallToggle } from './SalesBrainCallToggle'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import { recordRecentlyViewed } from '@renderer/lib/recentlyViewed'
import { formatDate, formatDuration, formatBytes } from './format'
import { PracticeMode } from './PracticeMode'
import { RadarReport } from '@renderer/features/deal-intelligence/ui/RadarReport'
import type { Attachment, Call, Commitment } from './types'
import type { DetectNameResult } from '../../../../preload/index.d'

/** mm:ss relative to call start — bookmarks store `atMs` as milliseconds. */
function formatMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// Local copy of the same escaping SpeakerTranscript uses internally for its
// `<mark>` highlighting — kept in sync by hand since SpeakerTranscript.tsx
// can't export a non-component helper (Fast Refresh only allows a component
// file to export components).
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Counts every case-insensitive occurrence of `query` across all segments,
 *  in the same top-to-bottom order SpeakerTranscript renders them, so the
 *  search box's "N of M" and up/down paging line up with what's highlighted. */
function countTranscriptMatches(segments: { text: string }[], query: string): number {
  const re = new RegExp(escapeRegExp(query), 'gi')
  let count = 0
  for (const seg of segments) {
    const found = seg.text.match(re)
    if (found) count += found.length
  }
  return count
}

const ACCEPT = '.pdf,.txt,.md,.docx'
const SUPPORTED = ['pdf', 'txt', 'md', 'docx']
const MAX_FILE_BYTES = 20 * 1024 * 1024

// M26 Phase 3 — job types backing the AI summary / Coach / Find commitments
// buttons below, tracked per-call via useJobByTarget so the spinner/result
// survives navigating away and back (see calls.ts for the executors).
const SUMMARIZE_JOB_TYPE = 'calls:summarize'
const COACH_JOB_TYPE = 'calls:coach'
const FIND_COMMITMENTS_JOB_TYPE = 'calls:findCommitments'
const DETECT_JOB_TYPE = 'contactIntelligence:detectName'

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
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [noKey, setNoKey] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [tasksAdded, setTasksAdded] = useState(0)
  const [coachError, setCoachError] = useState<string | null>(null)
  const [commitmentsError, setCommitmentsError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [practicing, setPracticing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const bodyScrollRef = useRef<HTMLDivElement>(null)
  const transcriptWrapperRef = useRef<HTMLDivElement>(null)
  // The transcript scrolls itself now, so bookmark jumps target this rather
  // than the page body.
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  // Collapsed by default. It is the longest object on the page and the last
  // thing a rep opens a past call to read — see docs/M31-design-research.md.
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  // The jump-to-end state moved into <ScrollToEnd>, which owns it for every
  // scroller it is attached to — including the re-measure on open, via its
  // ResizeObserver, which is why no flag has to be re-armed here any more.
  const { contacts, create: createContact } = useContacts()
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  // M23 Workstream D — Outlook events used to never reach the calendar-match
  // banner/auto-link at all (only googleEvents was ever fetched here), so an
  // Outlook-sourced meeting could never produce a suggestion even though the
  // matching algorithm and Outlook's own attendee data both already support
  // it (see speaker-identity/resolve-for-call.ts, which already merges both
  // for its own separate purpose). Fetched the same read-only-cache way as
  // googleEvents below.
  const [outlookEvents, setOutlookEvents] = useState<CalendarEvent[]>([])
  const [matchDismissed, setMatchDismissed] = useState(() => isMatchDismissed(callId))
  const { settings, loading: settingsLoading } = useAppSettings()
  const contactIntelligenceMode = settings.contactIntelligence?.mode ?? 'off'
  const [autoLinkNotice, setAutoLinkNotice] = useState<{
    contactId: string
    contactName: string
  } | null>(null)
  // Which call id we've already attempted to auto-link, so the effect below
  // fires at most once per call (linkContact clearing call.contactId as it
  // resolves must not re-trigger it). State, not a ref, since the render body
  // below also needs to read it (to skip the manual banner while pending).
  const [autoLinkAttemptedFor, setAutoLinkAttemptedFor] = useState<string | null>(null)
  // M23 Workstream D — post-hoc "Detect who this was" (transcript self-intro
  // scan). Mirrors autoLinkAttemptedFor's shape: which call id full-auto mode
  // has already tried detection for, so it fires at most once per call.
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detectedNothing, setDetectedNothing] = useState(false)
  const [autoDetectAttemptedFor, setAutoDetectAttemptedFor] = useState<string | null>(null)
  // A SEPARATE dismissal from matchDismissed (calendar-match banner) — the
  // two used to share one flag, so dismissing either suggestion silently
  // suppressed the other, unrelated one for that call. See
  // identitySuggestionDismiss.ts's own header comment.
  const [identityDismissed, setIdentityDismissed] = useState(() =>
    isIdentitySuggestionDismissed(callId)
  )

  const fileInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const onDeletedRef = useRef(onDeleted)
  useEffect(() => {
    onDeletedRef.current = onDeleted
  }, [onDeleted])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per-call state when navigating between calls, then fetch
    setCall(null)
    setMatchDismissed(isMatchDismissed(callId))
    setAutoLinkNotice(null)
    setAutoLinkAttemptedFor(null)
    setIdentityDismissed(isIdentitySuggestionDismissed(callId))
    // `detecting` is no longer local state — useJobByTarget re-adopts per
    // callId on its own, so there is nothing to reset here.
    setDetectError(null)
    setDetectedNothing(false)
    setAutoDetectAttemptedFor(null)
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
    void window.api.outlook.cachedEvents().then((events) => {
      if (active) setOutlookEvents(events)
    })
    return () => {
      active = false
    }
  }, [])

  // Cross-screen "recently viewed" trail — record once the call has actually
  // loaded (not on the initial null/loading render). Guarded via `call?.id`
  // (a member expression, not the bare `call` variable) so exhaustive-deps
  // is satisfied by the granular [call?.id, call?.title] dependency list.
  useEffect(() => {
    if (call?.id) recordRecentlyViewed('call', call.id, call.title)
  }, [call?.id, call?.title])

  const reload = useCallback(async () => {
    const c = await window.api.calls.get(callId)
    if (mountedRef.current && c) setCall(c)
  }, [callId])

  const removeBookmark = useCallback(
    async (bookmarkId: string) => {
      const updated = await window.api.calls.removeBookmark(callId, bookmarkId)
      if (!mountedRef.current) return
      if (updated) setCall(updated)
      else await reload()
    },
    [callId, reload]
  )

  // Approximate seek: no per-segment timing is stored, so this scrolls the
  // scrollable body proportionally (atMs / durationMs) against the
  // transcript card's own height — close enough to "roughly that point"
  // without segment-level timestamps to seek precisely.
  const scrollToBookmark = useCallback(
    (atMs: number) => {
      if (!call || call.durationMs <= 0) return
      // M31: the transcript is collapsed by default and scrolls internally,
      // so a bookmark jump has to OPEN it first. Without this the affordance
      // would still be clickable and would silently do nothing — the exact
      // "plausible but wrong" shape this milestone keeps removing.
      setTranscriptOpen(true)
      // Two frames: the list does not exist until after the state change has
      // painted, so scrollHeight is 0 if read any earlier.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const container = bodyScrollRef.current
          const wrapper = transcriptWrapperRef.current
          const inner = transcriptScrollRef.current
          if (!container || !wrapper) return
          container.scrollTo({ top: Math.max(0, wrapper.offsetTop - 24), behavior: 'smooth' })
          if (!inner) return
          const fraction = Math.min(1, Math.max(0, atMs / call.durationMs))
          // scrollHeight, not clientHeight: the content is now taller than
          // the box that shows it, and clientHeight would land every bookmark
          // inside the first screenful.
          inner.scrollTo({ top: fraction * inner.scrollHeight, behavior: 'smooth' })
        })
      })
    },
    [call]
  )

  const notifyChanged = useCallback(async () => {
    await reload()
    onChanged()
  }, [reload, onChanged])

  // M26 Phase 3 — tracks the summarize job for THIS call specifically
  // (targetRef-scoped), so switching to a different call never shows this
  // one's stale spinner/error, and coming back to a call whose summarize is
  // still running (or already finished while you were away) picks up
  // exactly where it left off instead of losing the button's feedback.
  const [summaryJob, startSummaryJob] = useJobByTarget(SUMMARIZE_JOB_TYPE, callId, {
    onSucceeded: () => void notifyChanged(),
    onFailed: (job) => {
      if (job.error?.code === 'no-key') setNoKey(true)
      else
        setSummaryError(job.error?.message ?? 'Could not generate the summary. Please try again.')
    }
  })
  const summarizing = summaryJob?.state === 'running' || summaryJob?.state === 'queued'

  const summarizeCall = useCallback(async () => {
    setSummaryError(null)
    setNoKey(false)
    try {
      const res = await window.api.calls.summarizeCall(callId)
      if (!mountedRef.current) return
      if (res.ok && res.jobId) {
        const fresh = await window.api.jobs.get(res.jobId)
        if (mountedRef.current && fresh) startSummaryJob(fresh)
      } else {
        setSummaryError('Could not start the summary. Please try again.')
      }
    } catch {
      if (mountedRef.current) setSummaryError('Could not generate the summary. Please try again.')
    }
  }, [callId, startSummaryJob])

  const [coachJob, startCoachJob] = useJobByTarget(COACH_JOB_TYPE, callId, {
    onSucceeded: () => void notifyChanged(),
    onFailed: (job) => {
      if (job.error?.code === 'no-key') setNoKey(true)
      else setCoachError(job.error?.message ?? 'Could not coach this call. Please try again.')
    }
  })
  const coaching = coachJob?.state === 'running' || coachJob?.state === 'queued'

  const coachCall = useCallback(async () => {
    setCoachError(null)
    setNoKey(false)
    try {
      const res = await window.api.calls.coachCall(callId)
      if (!mountedRef.current) return
      if (res.ok && res.jobId) {
        const fresh = await window.api.jobs.get(res.jobId)
        if (mountedRef.current && fresh) startCoachJob(fresh)
      } else {
        setCoachError('Could not start coaching. Please try again.')
      }
    } catch {
      if (mountedRef.current) setCoachError('Could not coach this call. Please try again.')
    }
  }, [callId, startCoachJob])

  const [commitmentsJob, startCommitmentsJob] = useJobByTarget(FIND_COMMITMENTS_JOB_TYPE, callId, {
    onSucceeded: () => void notifyChanged(),
    onFailed: (job) => {
      if (job.error?.code === 'no-key') setNoKey(true)
      else if (job.error?.code === 'empty-call') {
        setCommitmentsError('This call is too short to have any commitments worth extracting.')
      } else {
        setCommitmentsError(
          job.error?.message ?? 'Could not find commitments on this call. Please try again.'
        )
      }
    }
  })
  const findingCommitments =
    commitmentsJob?.state === 'running' || commitmentsJob?.state === 'queued'

  const findCommitments = useCallback(async () => {
    setCommitmentsError(null)
    setNoKey(false)
    try {
      const res = await window.api.calls.extractCommitments(callId)
      if (!mountedRef.current) return
      if (res.ok && res.jobId) {
        const fresh = await window.api.jobs.get(res.jobId)
        if (mountedRef.current && fresh) startCommitmentsJob(fresh)
      } else {
        setCommitmentsError('Could not start. Please try again.')
      }
    } catch {
      if (mountedRef.current) {
        setCommitmentsError('Could not find commitments on this call. Please try again.')
      }
    }
  }, [callId, startCommitmentsJob])

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

  const copyTranscript = useCallback(() => {
    if (!call) return
    // Must pass the same arguments the on-screen transcript does, or the copied
    // text labels speakers differently from what the user is reading — the
    // resolved identity and the recorded per-turn role both win over the
    // whole-call comparison, in that order (see meta.ts's speakerLabel).
    const repSpeaker = call.coaching?.metrics.repSpeaker ?? null
    const speakerCount = new Set(call.segments.map((s) => s.speaker)).size
    const text = call.segments
      .map(
        (seg) =>
          `${speakerLabel(
            seg.speaker,
            repSpeaker,
            speakerCount,
            seg.role,
            call.speakerIdentities,
            seg.channel
          )}: ${seg.text}`
      )
      .join('\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => {
        if (mountedRef.current) setCopied(false)
      }, 1500)
    })
  }, [call])

  const deleteCall = useCallback(async () => {
    await window.api.calls.delete(callId)
    onChanged()
    onDeleted()
  }, [callId, onChanged, onDeleted])

  // One in-flight guard for every link/create action: a double-click on
  // "Add as contact" used to create two contacts with the same email, and
  // failed IPC calls surfaced as unhandled rejections.
  const linkBusyRef = useRef(false)

  const doLink = useCallback(
    async (contactId: string | undefined) => {
      await window.api.calls.setContact(callId, contactId ?? null)
      await notifyChanged()
    },
    [callId, notifyChanged]
  )

  // M19 Task 2 — inline rename. Always source: 'manual', so the auto-
  // resolution cascade never overwrites it on a later re-run.
  const renameSpeaker = useCallback(
    async (key: string, name: string) => {
      // SpeakerTranscript's onRename is fired-and-forgotten (its prop type is
      // synchronous), so this must swallow its own errors -- otherwise a
      // failed IPC call surfaces as an unhandled rejection instead of just
      // leaving the label as it was, with the inline editor still available
      // for a retry.
      try {
        await window.api.calls.setSpeakerName(callId, key, name)
        await notifyChanged()
      } catch {
        /* label keeps its previous value; the rep can retry the rename */
      }
    },
    [callId, notifyChanged]
  )

  const linkContact = useCallback(
    async (contactId: string | undefined) => {
      if (linkBusyRef.current) return
      linkBusyRef.current = true
      try {
        await doLink(contactId)
      } catch {
        /* the picker/banner stays available for a retry */
      } finally {
        linkBusyRef.current = false
      }
    },
    [doLink]
  )

  const createAndLinkAttendee = useCallback(
    async (attendee: CalendarMatch['attendee']) => {
      if (linkBusyRef.current) return
      linkBusyRef.current = true
      try {
        const contact = await createContact({
          name: attendee.name || attendee.email,
          email: attendee.email
        })
        if (contact) await doLink(contact.id)
      } catch {
        /* the banner stays available for a retry */
      } finally {
        linkBusyRef.current = false
      }
    },
    [createContact, doLink]
  )

  const dismissMatchSuggestion = useCallback(() => {
    dismissMatch(callId)
    setMatchDismissed(true)
  }, [callId])

  const dismissIdentity = useCallback(() => {
    dismissIdentitySuggestion(callId)
    setIdentityDismissed(true)
  }, [callId])

  // M23 Workstream D — create/link a contact from a detected identity (as
  // opposed to createAndLinkAttendee above, which is calendar-match-sourced
  // and always has an email; a detected identity is name-only). Checks for
  // an existing EXACT-name-match contact first and links that instead of
  // creating a duplicate — a self-intro-only signal has no email to dedupe
  // by, so the same real buyer detected on two separate calls (neither with
  // a calendar invite) would otherwise silently mint two contact records
  // with no way to merge them later.
  const createAndLinkIdentity = useCallback(
    async (name: string) => {
      if (linkBusyRef.current) return
      linkBusyRef.current = true
      try {
        const existing = contacts.find(
          (c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()
        )
        if (existing) {
          await doLink(existing.id)
          return
        }
        const contact = await createContact({ name })
        if (contact) await doLink(contact.id)
      } catch {
        /* the banner stays available for a retry */
      } finally {
        linkBusyRef.current = false
      }
    },
    [contacts, createContact, doLink]
  )

  // M23 Workstream D — "Detect who this was" (post-hoc transcript scan for
  // the other party's name, either from their own self-introduction or from
  // the rep addressing/referring to them by name anywhere in the call).
  // Runs on click in 'suggest' mode, or automatically (once per call, see
  // the effect below) in 'full-auto' mode. In 'suggest' mode this only ever
  // populates a dismissible suggestion banner. In 'full-auto' mode the main
  // process ALSO auto-creates/attaches a contact as part of this same IPC
  // call (see maybeAutoCreateContact in contact-intelligence-ipc.ts) — the
  // notifyChanged() below picks up the resulting call.contactId, and the
  // background hook in calls.ts usually beats the rep to it anyway (full-
  // auto mode also runs right after the call is saved/coached, independent
  // of this page ever being opened).
  // M26 Phase 3 — tracked per-call, so the spinner and the outcome survive
  // navigating away. The job resolves with the full DetectNameResult (see
  // contact-intelligence-ipc.ts) rather than throwing on a non-error "found
  // nothing"/"gate is off" outcome, so all three cases still read
  // distinctly here.
  const [detectJob, startDetectJob] = useJobByTarget(DETECT_JOB_TYPE, callId, {
    onSucceeded: (job) => {
      const res = job.resultData as DetectNameResult | undefined
      if (!res) return
      if (res.ok && res.name) void notifyChanged()
      else if (res.ok) setDetectedNothing(true)
      else setDetectError(res.message ?? 'Could not detect who this was.')
    },
    onFailed: () => setDetectError('Could not detect who this was.')
  })
  const detecting = detectJob?.state === 'running' || detectJob?.state === 'queued'

  const detectIdentity = useCallback(async () => {
    if (detecting) return
    setDetectError(null)
    setDetectedNothing(false)
    try {
      const res = await window.api.contactIntelligence.detectName(callId)
      if (!mountedRef.current) return
      if (res.ok && res.jobId) {
        const fresh = await window.api.jobs.get(res.jobId)
        if (mountedRef.current && fresh) startDetectJob(fresh)
      } else {
        setDetectError('Could not detect who this was.')
      }
    } catch {
      if (mountedRef.current) setDetectError('Could not detect who this was.')
    }
  }, [callId, detecting, startDetectJob])

  // Auto-link (Settings → CRM, opt-in, default off): when there's exactly one
  // calendar match AND it points to a contact that already exists, link it
  // without asking — but never silently: a visible, undoable notice replaces
  // the manual banner. Never auto-creates a new contact.
  useEffect(() => {
    if (!call || settingsLoading) return
    if (call.contactId || matchDismissed || !settings.crm.calendarMatchEnabled) return
    if (!settings.crm.autoLinkUnambiguous) return
    if (autoLinkAttemptedFor === callId) return

    const matches = findCalendarMatches(
      call,
      [...googleEvents, ...outlookEvents],
      matchSensitivityMs(settings.crm.matchSensitivity)
    )
    if (matches.length !== 1) return // ambiguous (or no) match — leave it to the manual banner
    const existing = contacts.find((c) => c.email?.toLowerCase() === matches[0].attendee.email)
    if (!existing) return // never auto-CREATE a contact, only auto-link to one that exists

    // eslint-disable-next-line react-hooks/set-state-in-effect -- mark this call as attempted BEFORE the async link starts, so a fast re-render can't fire it twice
    setAutoLinkAttemptedFor(callId)
    void doLink(existing.id)
      .then(() => {
        setAutoLinkNotice({ contactId: existing.id, contactName: existing.name })
      })
      .catch(() => {
        /* link failed — no notice; the manual picker still works */
      })
  }, [
    call,
    callId,
    matchDismissed,
    autoLinkAttemptedFor,
    settingsLoading,
    settings.crm.calendarMatchEnabled,
    settings.crm.autoLinkUnambiguous,
    settings.crm.matchSensitivity,
    googleEvents,
    outlookEvents,
    contacts,
    doLink
  ])

  // M23 Workstream D — full-auto mode: run "Detect who this was" on its own,
  // once per call, when eligible. This is a fallback/fast-path for when the
  // rep opens the call before the background hook (calls.ts, right after
  // save/coaching) has finished — it goes through the exact same IPC call,
  // so it auto-creates/attaches a contact too, not just the suggestion
  // banner (see detectIdentity above). Calendar match (a stronger, email-
  // carrying signal) always takes priority and skips this entirely when it
  // would apply, to avoid a redundant AI call.
  useEffect(() => {
    if (!call || settingsLoading) return
    if (call.contactId || identityDismissed) return
    if (contactIntelligenceMode !== 'full-auto') return
    if (call.consent?.recordOtherParty !== true) return // same hard requirement the IPC handler enforces
    if (autoDetectAttemptedFor === callId) return
    const hasOtherPartyIdentity = call.speakerIdentities
      ? Object.values(call.speakerIdentities).some((id) => id.source !== 'user-profile')
      : false
    if (hasOtherPartyIdentity) return // already known, nothing to detect
    const calendarHit =
      settings.crm.calendarMatchEnabled &&
      findCalendarMatches(
        call,
        [...googleEvents, ...outlookEvents],
        matchSensitivityMs(settings.crm.matchSensitivity)
      ).length > 0
    if (calendarHit) return

    // eslint-disable-next-line react-hooks/set-state-in-effect -- mark this call as attempted BEFORE the async detect starts, so a fast re-render can't fire it twice
    setAutoDetectAttemptedFor(callId)
    void detectIdentity()
  }, [
    call,
    callId,
    identityDismissed,
    contactIntelligenceMode,
    autoDetectAttemptedFor,
    settingsLoading,
    settings.crm.calendarMatchEnabled,
    settings.crm.matchSensitivity,
    googleEvents,
    outlookEvents,
    detectIdentity
  ])

  // "Undo" on the auto-link notice — same as declining the suggestion: unlink
  // and treat it as dismissed, so it doesn't just auto-link right back.
  const undoAutoLink = useCallback(() => {
    // Unlink FIRST — only mark dismissed once it actually worked, so a failed
    // IPC call can't leave the call linked with the notice already gone.
    void doLink(undefined)
      .then(() => {
        dismissMatch(callId)
        setMatchDismissed(true)
        setAutoLinkNotice(null)
      })
      .catch(() => {
        /* still linked; the notice (with Undo) stays visible for a retry */
      })
  }, [callId, doLink])

  if (!call) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Skeleton className="mb-4 h-4 w-24" />
        <div className="mb-4">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="mt-2 h-3.5 w-1/2" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </div>
    )
  }

  const attachments = call.attachments ?? []
  // settingsLoading gate: the defaults claim the feature is ON while the real
  // settings load, which flashed the banner for users who turned it off.
  const calendarMatches =
    !call.contactId && !matchDismissed && !settingsLoading && settings.crm.calendarMatchEnabled
      ? findCalendarMatches(
          call,
          [...googleEvents, ...outlookEvents],
          matchSensitivityMs(settings.crm.matchSensitivity)
        )
      : []
  // While the auto-link effect is about to fire for this exact case, skip the
  // manual banner entirely instead of flashing it just before it's replaced.
  const autoLinkWillFire =
    settings.crm.autoLinkUnambiguous &&
    autoLinkAttemptedFor !== callId &&
    calendarMatches.length === 1 &&
    contacts.some((c) => c.email?.toLowerCase() === calendarMatches[0].attendee.email)

  // M23 Workstream D — a resolved identity for "the other party" (never
  // 'user-profile', which is always the rep's own key). Only meaningful for
  // a genuine one-on-one call, same as the calendar-match banner/cascade.
  const otherPartyIdentity = call.speakerIdentities
    ? Object.values(call.speakerIdentities).find((id) => id.source !== 'user-profile')
    : undefined
  const otherPartyContact = otherPartyIdentity?.contactId
    ? contacts.find((c) => c.id === otherPartyIdentity.contactId)
    : undefined
  // Calendar-match (above) always takes priority — it carries an email, a
  // stronger signal than a bare detected name, so never show both banners.
  const showIdentitySuggestion =
    contactIntelligenceMode !== 'off' &&
    !call.contactId &&
    !identityDismissed &&
    calendarMatches.length === 0 &&
    !!otherPartyIdentity
  // Is there anything to identify at all? If the contact is already linked,
  // already suggested, or the rep dismissed it, there is nothing to say and
  // nothing to show — an off-state here would be noise about a question that
  // is already answered.
  const identityUnresolved =
    !call.contactId && !identityDismissed && calendarMatches.length === 0 && !otherPartyIdentity

  const showDetectButton =
    identityUnresolved &&
    contactIntelligenceMode !== 'off' &&
    call.consent?.recordOtherParty === true

  // M31 Stage 3 — why the button is absent, when it is absent for a reason
  // the rep can act on (or should at least understand).
  //
  // The two cases are deliberately NOT the same state, which is the founder's
  // rule about prerequisites: "where a feature is off because it needs
  // something else first, say that rather than showing a toggle that won't
  // work." Turning the feature on cannot help a call that has no buyer
  // speech to scan, and consent for a call that already happened cannot be
  // granted retroactively — so that case gets an explanation and NO button,
  // because there is honestly nothing to press.
  const detectUnavailable: 'off' | 'no-other-party' | null = !identityUnresolved
    ? null
    : contactIntelligenceMode === 'off'
      ? 'off'
      : call.consent?.recordOtherParty !== true
        ? 'no-other-party'
        : null

  const tier = call.coaching ? overallTier(call.coaching.overallScore) : null

  if (practicing) {
    return <PracticeMode call={call} onExit={() => setPracticing(false)} />
  }

  const trimmedSearch = searchQuery.trim()
  const matchCount = trimmedSearch ? countTranscriptMatches(call.segments, trimmedSearch) : 0
  const clampedActiveMatch = matchCount > 0 ? Math.min(activeMatch, matchCount - 1) : 0
  const bookmarks = [...(call.bookmarks ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      {/* Top bar */}
      <div className="mb-4 flex items-center justify-between">
        <BackButton onClick={onBack} label="Past Calls" />
        <div className="flex items-center gap-1.5">
          {settings.salesBrain?.enabled && <SalesBrainCallToggle callId={call.id} />}
          {!confirmDelete && call.segments.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              onClick={() => setPracticing(true)}
            >
              Practice this call
            </Button>
          )}
          {confirmDelete ? (
            <>
              <Button variant="danger" size="sm" onClick={deleteCall}>
                Delete call
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={Trash2}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Title + meta */}
      <div className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{call.title}</h2>
          {/* M28 Part 4 — the assistant, scoped to this call's linked client. */}
          {call.contactId && (
            <Button
              variant="secondary"
              size="sm"
              icon={Sparkles}
              onClick={() => openAssistantFor({ contactId: call.contactId as string })}
            >
              Ask {ASSISTANT_SECTION_NAME}
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-4 text-[13px] text-muted">
          <span>{formatDate(call.createdAt)}</span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {formatDuration(call.durationMs)}
          </span>
          <span className="flex items-center gap-1">
            <Users className="h-3.5 w-3.5" /> {call.speakerCount} speaker
            {call.speakerCount === 1 ? '' : 's'}
          </span>
          {call.coaching && tier && (
            <Badge tone={TONE_TO_BADGE[tier.tone]}>
              <span className="tabular-nums">{call.coaching.overallScore}</span> · {tier.label}
            </Badge>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      {/* relative: anchors this screen's own ScrollToEnd. CallDetail is
          full-bleed, so AppShell's column does not scroll here and cannot
          host it. */}
      <div
        ref={bodyScrollRef}
        className="relative flex-1 space-y-4 overflow-y-auto pb-2"
      >
        {noKey && <NoKeyBanner />}

        {/* ── WHO ────────────────────────────────────────────────────────
            Founder call, and the right one: "who was this with" precedes
            "what happened". It is also state-dependent by the same rule as
            the summary and the coaching card — UNLINKED it is an action (a
            call with no contact is a record disconnected from the CRM, the
            deal and the history), and LINKED it is the identity everything
            below is about. Either way it belongs above the answers, not in
            the utility group where the first pass put it. */}
        {/* Linked contact */}
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <ContactIcon className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Contact</h3>
          </div>
          {autoLinkNotice ? (
            <div className="mb-3">
              <AutoLinkedNotice contactName={autoLinkNotice.contactName} onUndo={undoAutoLink} />
            </div>
          ) : (
            calendarMatches.length > 0 &&
            !autoLinkWillFire && (
              <div className="mb-3">
                <CalendarMatchSuggestion
                  matches={calendarMatches}
                  contacts={contacts}
                  onLink={(contactId) => void linkContact(contactId)}
                  onCreateAndLink={(attendee) => void createAndLinkAttendee(attendee)}
                  onDismiss={dismissMatchSuggestion}
                />
              </div>
            )
          )}
          {/* M23 Workstream D — a resolved identity's own suggestion, only
              when the calendar-match banner above isn't already showing. */}
          {!autoLinkNotice && showIdentitySuggestion && otherPartyIdentity && (
            <div className="mb-3">
              <IdentityContactSuggestion
                name={otherPartyIdentity.name}
                existingContactName={otherPartyContact?.name}
                onLink={() => otherPartyContact && void linkContact(otherPartyContact.id)}
                onCreate={() => void createAndLinkIdentity(otherPartyIdentity.name)}
                onDismiss={dismissIdentity}
              />
            </div>
          )}
          {!autoLinkNotice && detectUnavailable === 'off' && (
            <div className="mb-3">
              <EmptyState
                compact
                icon={UserSearch}
                title="Caller identification is switched off"
                reason={{
                  kind: 'off',
                  settingsPage: 'crm',
                  what: 'Reads the transcript for the moment the other person introduces themselves, then offers to link this call to that contact — or create them — instead of you typing the name in.',
                  cost: 'Makes one AI call when you ask it to, on this call only.',
                  actionLabel: 'Turn on caller identification'
                }}
              />
            </div>
          )}
          {!autoLinkNotice && detectUnavailable === 'no-other-party' && (
            <div className="mb-3">
              <EmptyState
                compact
                icon={UserSearch}
                title="Nobody to identify on this call"
                description="Caller identification reads the other person’s own words for a self-introduction, and this call was recorded without their side. That choice was made when the call happened and can’t be changed now — future calls recorded with both sides will offer it."
              />
            </div>
          )}
          {!autoLinkNotice && showDetectButton && (
            <div className="mb-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={detecting ? Loader2 : UserSearch}
                onClick={() => void detectIdentity()}
                disabled={detecting}
                className={detecting ? '[&_svg]:animate-spin' : ''}
              >
                {detecting ? 'Detecting…' : 'Detect who this was'}
              </Button>
              {detectError && <span className="text-[12px] text-danger">{detectError}</span>}
              {!detectError && detectedNothing && (
                <span className="text-[12px] text-faint">No self-introduction found.</span>
              )}
            </div>
          )}
          <ContactPicker
            value={call.contactId}
            contacts={contacts}
            onSelect={(contactId) => void linkContact(contactId)}
            onCreate={createContact}
          />
          {/* M32 Stage 2 — the deal link sits directly under the contact link
              because they are the same kind of fact about this call, and
              because the contact is what makes the deal list useful: it is
              what puts the right deals at the top. */}
          <CallDealPicker
            callId={callId}
            value={call.dealId}
            contactId={call.contactId}
            hasCoaching={Boolean(call.coaching)}
            onChanged={notifyChanged}
          />
        </Card>


        {/* ── WHAT HAPPENED ─────────────────────────────────────────────
            The answer to the first question a rep opens a past call with.
            State-dependent by design: an unsummarised call shows the action
            here, a summarised one shows the answer, in the same place. */}
        {/* AI summary */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">AI summary</h3>
            </div>
            {call.summary && !summarizing && (
              <Button variant="secondary" size="sm" icon={RotateCw} onClick={summarizeCall}>
                Regenerate
              </Button>
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
              {summaryError && <p className="text-[13px] text-danger">{summaryError}</p>}
              <Button icon={Sparkles} onClick={summarizeCall}>
                Summarize
              </Button>
            </div>
          )}
        </Card>

        {/* ── WHAT DO I OWE ─────────────────────────────────────────────
            Commitments and tasks: the things that turn into work. Second
            because they are time-sensitive in a way the coaching is not. */}
        {/* Commitments (§4.7) — who promised what */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">Commitments</h3>
            </div>
            {call.commitments && !findingCommitments && (
              <Button variant="secondary" size="sm" icon={RotateCw} onClick={findCommitments}>
                Re-check
              </Button>
            )}
          </div>
          {findingCommitments ? (
            <div className="space-y-2.5">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : call.commitments ? (
            call.commitments.length === 0 ? (
              <p className="text-sm text-muted">
                Nobody committed to anything specific on this call.
              </p>
            ) : (
              <CommitmentsList commitments={call.commitments} />
            )
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">
                Pull out every &ldquo;I&rsquo;ll send the pricing&rdquo; and &ldquo;we&rsquo;ll loop
                in our CISO&rdquo; from this call, split by who owes it — the list you check before
                the next call, not a line buried in a summary.
              </p>
              {commitmentsError && <p className="text-[13px] text-danger">{commitmentsError}</p>}
              <Button icon={ClipboardList} onClick={findCommitments}>
                Find commitments
              </Button>
            </div>
          )}
        </Card>

        {/* Tasks */}
        <Card>
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
              <p className="text-[13px] text-positive">
                Added {tasksAdded} {tasksAdded === 1 ? 'task' : 'tasks'} — find them in the Tasks
                tab.
              </p>
            )}
            <Button icon={ListChecks} onClick={() => setShowTasks(true)}>
              Generate tasks
            </Button>
          </div>
        </Card>

        {/* ── WHAT DID I DO WRONG ───────────────────────────────────────
            Coaching, live-deal radar, objection mining. Same state-dependent
            rule as the summary: the button and the scorecard occupy one
            position. */}
        {/* Sales coaching */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GraduationCap className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">Sales coaching</h3>
            </div>
            {call.coaching && !coaching && (
              <Button variant="secondary" size="sm" icon={RotateCw} onClick={coachCall}>
                Re-coach
              </Button>
            )}
          </div>
          {coaching ? (
            <CoachLoading />
          ) : call.coaching ? (
            <CoachReportView
              report={call.coaching}
              callId={callId}
              callTitle={call.title}
              identities={call.speakerIdentities}
              multichannel={call.segments.some((s) => s.channel !== undefined)}
            />
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">
                Get an evidence-based scorecard for this call — six coaching dimensions scored 1–5
                with quotes from the transcript, your talk-time metrics, your top two things to
                improve, and one concrete thing to try on your next call.
              </p>
              {coachError && <p className="whitespace-pre-wrap text-[13px] text-danger">{coachError}</p>}
              <Button icon={GraduationCap} onClick={coachCall}>
                Coach this call
              </Button>
            </div>
          )}
        </Card>

        {/* Radar Report (M24 §8) — what Live Deal Intelligence caught live,
            reviewable after the fact. Only ever present when the Beta was on
            for this call; there's no post-hoc "run it now" the way
            Commitments/Coaching have, since Tiers 1/2 only ever see the
            transcript as it happened live. */}
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <Radar className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Radar Report</h3>
          </div>
          {call.dealIntelligence ? (
            <RadarReport record={call.dealIntelligence} />
          ) : settings.dealIntelligence.enabled ? (
            // ON, but this call predates it (or nothing was caught). NOT an
            // off-state: telling someone to switch on what is already on is
            // the specific harm the tri-state exists to avoid.
            <EmptyState
              compact
              icon={Radar}
              title="Nothing was flagged on this call"
              description="Deal risk signals are watched for live. This call either predates the feature or ran clean."
            />
          ) : (
            // OFF. The wording has to carry a caveat most off-states do not:
            // turning it on CANNOT populate this call. Tiers 1/2 only ever see
            // the transcript as it happens, so there is no post-hoc "run it
            // now" the way Coaching and Commitments have. An off-state that
            // implied otherwise would be a promise the button cannot keep.
            <EmptyState
              compact
              icon={Radar}
              title="Deal risk watching is switched off"
              reason={{
                kind: 'off',
                settingsPage: 'live-deal-intelligence',
                what: 'Listens during a live call for signs the deal is slipping — a decision-maker who never appears, a budget question that gets dodged, a timeline that keeps moving — and flags each one as it happens.',
                cost: 'Beta. Makes extra AI calls while a call is running, so it costs provider usage. Applies from your NEXT call onwards — it cannot go back over this one.',
                actionLabel: 'Turn on deal risk watching'
              }}
            />
          )}
        </Card>

        <MineTestPanel callId={callId} enabled={settings.objectionMining.enabled} />

        {/* ── ASK ───────────────────────────────────────────────────────
            Interactive, and placed after the three questions above so the
            rep has the context before they start asking about it. */}
        {/* M23 Workstream B — coaching chat (advisor + practice mode) */}
        <CoachChatCard
          callId={callId}
          initialMessages={call.coachChat ?? []}
          hasContact={!!call.contactId}
        />

        {/* ── UTILITY ───────────────────────────────────────────────────
            Real, used rarely, and not what the page is opened for. */}
        {/* Bookmarks */}
        {bookmarks.length > 0 && (
          <Card>
            <div className="mb-4 flex items-center gap-2">
              <BookmarkIcon className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">Bookmarks</h3>
              <span className="text-[11px] text-faint">{bookmarks.length}</span>
            </div>
            <div className="space-y-2.5">
              {bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  className="flex items-start gap-3 rounded-xl border border-line-soft bg-canvas p-3"
                >
                  <button
                    type="button"
                    onClick={() => scrollToBookmark(bm.atMs)}
                    className="shrink-0 rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold tabular-nums text-accent transition hover:brightness-110"
                  >
                    {formatMmSs(bm.atMs)}
                  </button>
                  <p className="min-w-0 flex-1 line-clamp-2 text-sm text-ink">{bm.text}</p>
                  <IconButton
                    icon={Trash2}
                    label="Remove bookmark"
                    variant="danger"
                    onClick={() => void removeBookmark(bm.id)}
                  />
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Files */}
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-faint" />
              <h3 className="text-sm font-semibold">Files</h3>
              {attachments.length > 0 && (
                <span className="text-[11px] text-faint">{attachments.length}</span>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={Plus}
              disabled={adding}
              onClick={() => fileInputRef.current?.click()}
            >
              {adding ? 'Adding…' : 'Add file'}
            </Button>
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
          {addError && <p className="mb-3 text-[13px] text-danger">{addError}</p>}
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
        </Card>
        {/* ── THE RECORD ────────────────────────────────────────────────
            LAST, and collapsed. It is the longest object on the page and it
            used to sit fifth of thirteen, so every action lived below it: on
            the founder's own 116-segment call that is ~10 screens of
            scrolling before "Coach this call", and ~20 on a p90 call.
            Kept on this page rather than moved to a tab because the coaching
            scorecard QUOTES it — claim and evidence belong in one scroll.
            See docs/M31-design-research.md for why the side-panel variant is
            blocked by the 880px width floor. */}
        {/* Transcript */}
        <div
          ref={transcriptWrapperRef}
          className="rounded-2xl border border-line-soft bg-surface px-7 py-6"
        >
          <div className="mb-4 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setTranscriptOpen((o) => !o)}
              aria-expanded={transcriptOpen}
              className="-ml-1 flex items-center gap-2 rounded-md px-1 py-0.5 text-sm font-semibold transition-colors hover:text-ink"
            >
              <ChevronRight
                className={cn(
                  'h-4 w-4 shrink-0 text-faint transition-transform',
                  transcriptOpen && 'rotate-90'
                )}
                strokeWidth={2.5}
              />
              Transcript
              {/* The count is the honest preview of what opening costs. */}
              {call.segments.length > 0 && (
                <span className="text-[12px] font-normal text-faint">
                  {call.segments.length} lines
                </span>
              )}
            </button>
            {call.segments.length > 0 && transcriptOpen && (
              <IconButton
                icon={copied ? Check : Copy}
                label="Copy transcript"
                onClick={copyTranscript}
              />
            )}
          </div>
          {call.segments.length > 0 && transcriptOpen && (
            <div className="mb-4 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setActiveMatch(0)
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || matchCount === 0) return
                    e.preventDefault()
                    setActiveMatch((i) =>
                      e.shiftKey ? (i - 1 + matchCount) % matchCount : (i + 1) % matchCount
                    )
                  }}
                  placeholder="Search transcript…"
                  className={cn(fieldClass, 'pl-8')}
                />
              </div>
              {trimmedSearch && (
                <div className="flex shrink-0 items-center gap-0.5 text-[12px] text-muted">
                  <span className="mr-1 tabular-nums">
                    {matchCount > 0 ? `${clampedActiveMatch + 1} of ${matchCount}` : 'No matches'}
                  </span>
                  <IconButton
                    icon={ChevronUp}
                    label="Previous match"
                    disabled={matchCount === 0}
                    onClick={() => setActiveMatch((i) => (i - 1 + matchCount) % matchCount)}
                  />
                  <IconButton
                    icon={ChevronDown}
                    label="Next match"
                    disabled={matchCount === 0}
                    onClick={() => setActiveMatch((i) => (i + 1) % matchCount)}
                  />
                </div>
              )}
            </div>
          )}
          {!transcriptOpen ? null : call.segments.length > 0 ? (
            /* THE MECHANICAL FIX. This container had no max-height and no
               overflow, so it rendered every segment at full height and
               pushed all eight sections below it down the page. On the
               founder's own 116-segment call that was ~10 screens of scroll
               before "Coach this call", and the longest call on this machine
               has 479 segments (~44 screens). Reordering alone would not have
               fixed that — it would have moved the cliff, not removed it. */
            <div className="relative">
              <div
                ref={transcriptScrollRef}
                className="max-h-[60vh] overflow-y-auto pr-1"
              >
                <SpeakerTranscript
                  segments={call.segments}
                  repSpeaker={call.coaching?.metrics.repSpeaker ?? null}
                  highlightQuery={trimmedSearch}
                  activeMatchIndex={matchCount > 0 ? clampedActiveMatch : undefined}
                  identities={call.speakerIdentities}
                  onRename={renameSpeaker}
                />
              </div>
              <ScrollToEnd
                targetRef={transcriptScrollRef}
                label="Jump to the end of the transcript"
              />
            </div>
          ) : (
            <p className="text-sm italic text-faint">This call has no transcript.</p>
          )}
        </div>

        {/* Page-level jump. The transcript has its own (scoped to the
            transcript box) because with the record collapsed these are two
            different destinations — "end of the call" and "end of the page"
            stopped being the same place when the transcript got its own
            scroller. */}
        <ScrollToEnd targetRef={bodyScrollRef} label="Jump to the bottom of this call" />
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

/** `Mar 14` from an ISO `YYYY-MM-DD`, never re-parsed with a timezone that
 *  could roll it to the wrong day (see cleanDate's round-trip check in
 *  main/commitments.ts — this only ever receives a value that already passed
 *  it). */
function formatDueDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

function CommitmentGroup({
  title,
  items
}: {
  title: string
  items: Commitment[]
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div>
      <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</h4>
      <ul className="space-y-2">
        {items.map((c, i) => (
          <li key={i} className="flex items-start justify-between gap-3 text-sm">
            <span className="text-ink">{c.text}</span>
            {c.dueDate && (
              <Badge tone="neutral" className="shrink-0">
                {formatDueDate(c.dueDate)}
              </Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CommitmentsList({ commitments }: { commitments: Commitment[] }): React.JSX.Element {
  const rep = commitments.filter((c) => c.owner === 'rep')
  const prospect = commitments.filter((c) => c.owner === 'prospect')
  return (
    <div className="space-y-4">
      <CommitmentGroup title="You committed to" items={rep} />
      <CommitmentGroup title="They committed to" items={prospect} />
    </div>
  )
}

function NoKeyBanner(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
      <p className="font-medium">Add your Anthropic API key</p>
      <p className="mt-1 text-warning/80">
        AI summaries need an Anthropic key. Get one at console.anthropic.com, paste it into{' '}
        <span className="text-warning">Settings → API keys</span>, then try again — it takes effect
        immediately, no restart needed.
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset transient UI state when the attachment identity changes
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
            <Button variant="secondary" size="sm" icon={Sparkles} onClick={summarize}>
              {attachment.summary ? 'Regenerate' : 'Summarize'}
            </Button>
          )}
          {confirmRemove ? (
            <>
              <Button variant="danger" size="sm" onClick={remove}>
                Remove
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <IconButton
              icon={Trash2}
              label="Remove file"
              variant="danger"
              onClick={() => setConfirmRemove(true)}
            />
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
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
