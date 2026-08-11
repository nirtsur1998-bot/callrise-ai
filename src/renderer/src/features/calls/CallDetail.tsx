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
  Bookmark as BookmarkIcon,
  ClipboardList,
  Radar,
  UserSearch,
  Loader2
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import { SummaryView, SummaryLoading } from '@renderer/components/SummaryView'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import { BackButton } from '@renderer/components/BackButton'
import { Card } from '@renderer/components/Card'
import { Skeleton } from '@renderer/components/Skeleton'
import { fieldClass } from '@renderer/components/field'
import { overallTier, TONE_TO_BADGE, speakerLabel } from '@renderer/features/coaching/meta'
import { Badge } from '@renderer/components/Badge'
import { GenerateTasksDialog } from '@renderer/features/tasks/GenerateTasksDialog'
import { CoachReportView, CoachLoading } from '@renderer/features/coaching/CoachReportView'
import { CoachChatCard } from '@renderer/features/coaching/CoachChatPanel'
import { MineTestPanel } from '@renderer/features/objection-library/MineTestPanel'
import { useContacts } from '@renderer/features/contacts/useContacts'
import { ContactPicker } from '@renderer/features/contacts/ContactPicker'
import {
  CalendarMatchSuggestion,
  AutoLinkedNotice
} from '@renderer/features/contacts/CalendarMatchSuggestion'
import { IdentityContactSuggestion } from './IdentityContactSuggestion'
import { isIdentitySuggestionDismissed, dismissIdentitySuggestion } from './identitySuggestionDismiss'
import {
  findCalendarMatches,
  isMatchDismissed,
  dismissMatch,
  matchSensitivityMs,
  type CalendarMatch
} from '@renderer/features/contacts/calendarMatch'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import { recordRecentlyViewed } from '@renderer/lib/recentlyViewed'
import { formatDate, formatDuration, formatBytes } from './format'
import { PracticeMode } from './PracticeMode'
import { RadarReport } from '@renderer/features/deal-intelligence/ui/RadarReport'
import type { Attachment, Call, Commitment } from './types'

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
  const [findingCommitments, setFindingCommitments] = useState(false)
  const [commitmentsError, setCommitmentsError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [practicing, setPracticing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const bodyScrollRef = useRef<HTMLDivElement>(null)
  const transcriptWrapperRef = useRef<HTMLDivElement>(null)
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
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detectedNothing, setDetectedNothing] = useState(false)
  const [autoDetectAttemptedFor, setAutoDetectAttemptedFor] = useState<string | null>(null)
  // A SEPARATE dismissal from matchDismissed (calendar-match banner) — the
  // two used to share one flag, so dismissing either suggestion silently
  // suppressed the other, unrelated one for that call. See
  // identitySuggestionDismiss.ts's own header comment.
  const [identityDismissed, setIdentityDismissed] = useState(() => isIdentitySuggestionDismissed(callId))

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
    setDetecting(false)
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
      const container = bodyScrollRef.current
      const wrapper = transcriptWrapperRef.current
      if (!container || !wrapper || !call || call.durationMs <= 0) return
      const fraction = Math.min(1, Math.max(0, atMs / call.durationMs))
      const target = wrapper.offsetTop + fraction * wrapper.clientHeight
      container.scrollTo({ top: Math.max(0, target - 24), behavior: 'smooth' })
    },
    [call]
  )

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

  const findCommitments = useCallback(async () => {
    setCommitmentsError(null)
    setNoKey(false)
    setFindingCommitments(true)
    try {
      const res = await window.api.calls.extractCommitments(callId)
      if (!mountedRef.current) return
      if (res.ok) await notifyChanged()
      else if (res.error === 'no-key') setNoKey(true)
      else if (res.error === 'empty-call') {
        setCommitmentsError('This call is too short to have any commitments worth extracting.')
      } else setCommitmentsError(res.message ?? 'Could not find commitments on this call.')
    } catch {
      if (mountedRef.current) {
        setCommitmentsError('Could not find commitments on this call. Please try again.')
      }
    } finally {
      if (mountedRef.current) setFindingCommitments(false)
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
        const existing = contacts.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase())
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

  // M23 Workstream D — "Detect who this was" (post-hoc transcript self-intro
  // scan). Runs on click in 'suggest' mode, or automatically (once per call,
  // see the effect below) in 'full-auto' mode — but the result only ever
  // populates a dismissible suggestion banner; it never creates or links a
  // contact on its own.
  const detectIdentity = useCallback(async () => {
    if (detecting) return
    setDetecting(true)
    setDetectError(null)
    setDetectedNothing(false)
    try {
      const res = await window.api.contactIntelligence.detectName(callId)
      if (!mountedRef.current) return
      if (res.ok) {
        if (res.name) {
          await notifyChanged() // refresh so the new identity shows up
        } else {
          setDetectedNothing(true) // ran cleanly, nothing found — not an error
        }
      } else {
        setDetectError(res.message ?? 'Could not detect who this was.')
      }
    } catch {
      if (mountedRef.current) setDetectError('Could not detect who this was.')
    } finally {
      if (mountedRef.current) setDetecting(false)
    }
  }, [callId, detecting, notifyChanged])

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
  // once per call, when eligible — but this still only ever populates a
  // dismissible suggestion banner (see detectIdentity/IdentityContactSuggestion
  // above); it never creates or links a contact without a click. Calendar
  // match (a stronger, email-carrying signal) always takes priority and
  // skips this entirely when it would apply, to avoid a redundant AI call.
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
  const showDetectButton =
    contactIntelligenceMode !== 'off' &&
    !call.contactId &&
    !identityDismissed &&
    calendarMatches.length === 0 &&
    !otherPartyIdentity &&
    call.consent?.recordOtherParty === true

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
          {call.coaching && tier && (
            <Badge tone={TONE_TO_BADGE[tier.tone]}>
              <span className="tabular-nums">{call.coaching.overallScore}</span> · {tier.label}
            </Badge>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div ref={bodyScrollRef} className="flex-1 space-y-4 overflow-y-auto pb-2">
        {noKey && <NoKeyBanner />}

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
        </Card>

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

        {/* Transcript */}
        <div
          ref={transcriptWrapperRef}
          className="rounded-2xl border border-line-soft bg-surface px-7 py-6"
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Transcript</h3>
            {call.segments.length > 0 && (
              <IconButton
                icon={copied ? Check : Copy}
                label="Copy transcript"
                onClick={copyTranscript}
              />
            )}
          </div>
          {call.segments.length > 0 && (
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
          {call.segments.length > 0 ? (
            <SpeakerTranscript
              segments={call.segments}
              repSpeaker={call.coaching?.metrics.repSpeaker ?? null}
              highlightQuery={trimmedSearch}
              activeMatchIndex={matchCount > 0 ? clampedActiveMatch : undefined}
              identities={call.speakerIdentities}
              onRename={renameSpeaker}
            />
          ) : (
            <p className="text-sm italic text-faint">This call has no transcript.</p>
          )}
        </div>

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
              {coachError && <p className="text-[13px] text-danger">{coachError}</p>}
              <Button icon={GraduationCap} onClick={coachCall}>
                Coach this call
              </Button>
            </div>
          )}
        </Card>

        {/* M23 Workstream B — coaching chat (advisor + practice mode) */}
        <CoachChatCard callId={callId} initialMessages={call.coachChat ?? []} hasContact={!!call.contactId} />

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

        {/* Radar Report (M24 §8) — what Live Deal Intelligence caught live,
            reviewable after the fact. Only ever present when the Beta was on
            for this call; there's no post-hoc "run it now" the way
            Commitments/Coaching have, since Tiers 1/2 only ever see the
            transcript as it happened live. */}
        {call.dealIntelligence && (
          <Card>
            <div className="mb-4 flex items-center gap-2">
              <Radar className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">Radar Report</h3>
            </div>
            <RadarReport record={call.dealIntelligence} />
          </Card>
        )}

        <MineTestPanel callId={callId} enabled={settings.objectionMining.enabled} />

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
