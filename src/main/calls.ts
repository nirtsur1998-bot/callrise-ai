import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import mammoth from 'mammoth'
import { generatePostCallBrief, type PostCallBriefResult } from './post-call-brief'
import {
  speechSegments,
  saveCall,
  listCalls,
  getCall,
  deleteCall,
  addAttachment,
  removeAttachment,
  readAttachment,
  setCallSummary,
  setAttachmentSummary,
  setCallCoaching,
  setCallCommitments,
  setCallDealIntelligence,
  setCallTitle,
  setCallContact,
  setCallCallType,
  setCallTypeIfUnset,
  setCallObjectionsMined,
  setCallCrmNoteGenerated,
  addBookmark,
  removeBookmark,
  setSpeakerIdentity,
  type CallSaveInput,
  type CallSummary,
  type CallType
} from './calls-fs'
import { summarize, type SummarizeInput, type SummaryResult } from './summarize'
import { coachCall } from './coach'
import { extractCommitments, type CommitmentResult } from './commitments'
import { generateCallTitle, type GenerateTitleResult } from './call-title'
import { mineObjections, makeVerifier, type ObjectionMiningResult } from './objection-mining'
import { addToQueue, purgeQueueForCall } from './objection-queue-fs'
import {
  isObjectionMiningEnabled,
  loadAppSettings,
  isSelfIntroExtractionAllowed,
  isSalesBrainEnabled
} from './app-settings'
import { scheduleBackup, queueAttachmentBlobDeletes } from './backup'
import { addComment } from './contacts-fs'
import { generateCrmNote } from './crm-notes'
import { resolveAndSaveIdentities } from './speaker-identity/resolve-for-call'
import { runFullAutoContactIntelligence } from './contact-intelligence-ipc'
import { runMemoryExtractionForCall } from './memory/memory-hooks'
import {
  computePersonalTalkRatioTarget,
  computePersonalQuestionTarget
} from './memory/personal-benchmarks'
import { detectCallType, TALK_RATIO_TARGETS } from './coaching/benchmarks'
import {
  computeSkillProgress,
  type PersonalBenchmarks,
  type SkillProgress
} from './coaching/skill-graph'
import { selectFocusSkill, type FocusSkillState } from './coaching/focus-skill'
import { loadFocusSkill, saveFocusSkill } from './coaching/focus-skill-fs'
import { getJobManager } from './jobs/instance'
import type { Job } from './jobs/types'

function objectionQueueDir(): string {
  return join(app.getPath('userData'), 'objection-queue')
}

function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

/** Calls with a mining request currently in flight. The mined-at flag is only
 *  written AFTER the (slow) AI call returns, so without this set an auto-mine
 *  racing the manual scan — or two overlapping scans — would mine the same
 *  call twice and duplicate its candidates in the review queue. */
const miningInFlight = new Set<string>()
/** M26 Phase 3 — job type for the manual "scan my past calls" trigger below.
 *  Registered once, from registerCalls(), which always runs after main has
 *  created and set the shared JobManager (see main/index.ts). */
const SCAN_JOB_TYPE = 'objections:scanPastCalls'
const SUMMARIZE_JOB_TYPE = 'calls:summarize'
const COACH_JOB_TYPE = 'calls:coach'

/** Mine one call and stage any grounded candidates in the review queue, then
 *  mark the call as mined — shared by the new-call auto-mine hook and the
 *  manual "scan past calls" trigger. Only marks the call mined on SUCCESS, so
 *  a transient failure (e.g. a rate limit) leaves it eligible for a retry. */
async function mineCallIntoQueue(callId: string): Promise<{ ok: boolean; added: number }> {
  if (miningInFlight.has(callId)) return { ok: false, added: 0 }
  miningInFlight.add(callId)
  try {
    const call = await getCall(callsDir(), callId)
    if (!call?.segments?.length) return { ok: false, added: 0 }
    // Re-check on the fresh read: another path may have finished mining this
    // call after the caller built its eligible list.
    if (call.objectionsMinedAt) return { ok: true, added: 0 }
    const result = await mineObjections(speechSegments(call.segments))
    if (!result.ok) return { ok: false, added: 0 }
    const items = await addToQueue(objectionQueueDir(), result.candidates, callId, call.title)
    await setCallObjectionsMined(callsDir(), callId)
    return { ok: true, added: items.length }
  } finally {
    miningInFlight.delete(callId)
  }
}

/** Calls with a CRM-note request currently in flight — same double-fire guard
 *  as miningInFlight (the contact-link and summary-saved triggers can both
 *  fire for the same call in close succession). */
const crmNoteInFlight = new Set<string>()

/** M25 Phase 3 (L3 procedural memory) — the rep's own personal talk-ratio/
 *  question-count norms, computed fresh from their own past coached calls
 *  of the SAME call type every time coaching runs (not cached — cheap
 *  enough: one directory scan via listCalls(), same cost this app already
 *  pays for the Progress dashboard). Returns undefined for either field
 *  individually when there isn't enough history yet — see personal-
 *  benchmarks.ts's MIN_SAMPLE_SIZE, the guard against confidently-wrong
 *  personalization from too small a sample. */
async function computePersonalBenchmarksForCallType(
  callType: CallType
): Promise<PersonalBenchmarks | undefined> {
  const past = await listCalls(callsDir())
  const sameType = past.filter((c) => c.callType === callType && c.hasCoaching)

  const talkRatioTarget =
    computePersonalTalkRatioTarget(
      sameType.map((c) => ({ talkRatio: c.talkRatio ?? null })),
      TALK_RATIO_TARGETS[callType]
    ) ?? undefined
  const questionTarget =
    computePersonalQuestionTarget(sameType.map((c) => ({ count: c.questionCount ?? 0 }))) ??
    undefined

  if (!talkRatioTarget && !questionTarget) return undefined
  return { talkRatioTarget, questionTarget }
}

/** Draft a short AI CRM note from a call and append it to its linked
 *  contact — opt-in (Settings → CRM → "Auto-generate notes"), fires from
 *  BOTH the "call linked to a contact" and "call summarized" paths (whichever
 *  happens second actually has enough context + the link). Only marks the
 *  call as done on SUCCESS, so a transient failure (rate limit, no key)
 *  leaves it eligible for the other trigger to retry. */
async function maybeGenerateCrmNote(callId: string): Promise<void> {
  if (!loadAppSettings().crm.autoGenerateNotes) return
  if (crmNoteInFlight.has(callId)) return
  crmNoteInFlight.add(callId)
  try {
    const call = await getCall(callsDir(), callId)
    if (!call || call.crmNoteGeneratedAt || !call.contactId) return
    const content = call.summary?.executive
      ? [call.summary.executive, ...call.summary.keyPoints].join('\n')
      : speechSegments(call.segments)
          .map((s) => `Speaker ${s.speaker + 1}: ${s.text}`)
          .join('\n')
    if (!content.trim()) return
    const result = await generateCrmNote(content)
    if (!result.ok) return
    const contact = await addComment(contactsDir(), call.contactId, result.note, 'ai')
    if (contact) scheduleBackup()
    await setCallCrmNoteGenerated(callsDir(), callId)
  } finally {
    crmNoteInFlight.delete(callId)
  }
}

/** M23 Workstream A4 — after a Coach 2.0 scorecard is saved, re-derive skill
 *  progress from this rep's whole call history and update the Focus Skill
 *  (rotating only on sustained improvement — see focus-skill.ts). Best
 *  effort: a failure here never fails the coaching call itself, since the
 *  scorecard the rep is looking at is already saved by the time this runs. */
async function updateFocusSkillAfterCoaching(callId: string): Promise<void> {
  const call = await getCall(callsDir(), callId)
  if (!call?.coaching?.skills) return
  const summaries = await listCalls(callsDir())
  const progress: SkillProgress[] = computeSkillProgress(
    summaries.map((s) => ({ id: s.id, createdAt: s.createdAt, skills: s.skills }))
  )
  const current = await loadFocusSkill()
  const next: FocusSkillState = selectFocusSkill(
    progress,
    current,
    call.coaching,
    callId,
    new Date().toISOString()
  )
  await saveFocusSkill(next)
}

/** A call is "eligible" for mining once it has a transcript and hasn't been
 *  mined yet — shared by the scan estimate and the scan itself so the count
 *  shown before confirming always matches what the scan will actually do. */
function eligibleForMining(calls: CallSummary[]): CallSummary[] {
  return calls.filter(
    (c) => !c.objectionsMined && typeof c.preview === 'string' && c.preview.trim().length > 0
  )
}

/** Extract text from a .docx. Returns null when the file can't be parsed at all. */
async function extractDocxText(bytes: Buffer): Promise<string | null> {
  try {
    const result = await mammoth.extractRawText({ buffer: bytes })
    return result.value ?? ''
  } catch {
    return null
  }
}

/** Cheap heuristic that a UTF-8-decoded buffer is actually readable text. */
function looksLikeText(text: string): boolean {
  if (text.length === 0) return false
  const sample = text.slice(0, 4000)
  let bad = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    // U+FFFD (replacement char from a bad decode) or a NUL byte signals binary.
    if (code === 0xfffd || code === 0) bad++
  }
  return bad / sample.length < 0.1
}

const SAVE_FAILED: SummaryResult = {
  ok: false,
  error: 'failed',
  message: 'The summary could not be saved. Please try again.'
}

let registered = false

export function registerCalls(): void {
  if (registered) return
  registered = true

  ipcMain.handle('calls:list', () => listCalls(callsDir()))
  ipcMain.handle('calls:get', (_event, id: string) => getCall(callsDir(), id))
  ipcMain.handle(
    'calls:save',
    async (_event, input: CallSaveInput, selfIntro?: { key: string; name: string }) => {
      const summary = await saveCall(callsDir(), input)
      scheduleBackup() // metadata only reaches the cloud (segments never included)
      // Fire-and-forget: never block the save on an AI call. Only runs when the
      // Objection Library toggle is on — this is the "new calls going forward"
      // half of the mining scope (the other half is the manual scan below).
      if (isObjectionMiningEnabled()) {
        void mineCallIntoQueue(summary.id).catch(() => {})
      }
      // M19 Task 2 step 5 — applied and AWAITED before the cascade below
      // starts, so ordering is deterministic: self-intro lands first as a
      // placeholder, then the cascade (fully async, fire-and-forget) can
      // still overwrite it with a higher-confidence calendar/contact match,
      // exactly the priority the naming cascade is supposed to have. Guarded
      // by the same setting the cascade itself checks — a self-intro name
      // extracted while the setting was on shouldn't survive it being turned
      // off between the call and the save (a narrow window, but a real one).
      //
      // ALSO gated on the call's OWN consent, re-read fresh here (not trusted
      // from the renderer, which can only send a stale snapshot from whenever
      // the self-intro resolved) — selfIntro.key always names the OTHER
      // party, and writing their real name is exactly the kind of personal
      // data the M11 consent-retention invariant governs. A rep can revoke
      // buyer consent mid-call (after a self-intro already resolved) and the
      // save must not persist their name once that happens, matching the
      // same-save segment strip applyConsentRetention already performs
      // (which now also strips any speakerIdentities entry that DOES get
      // written outside consent, as a second line of defense — see its own
      // doc comment in calls-fs.ts — but the write is prevented here too,
      // rather than relying solely on next-read cleanup).
      if (selfIntro?.key && selfIntro.name && isSelfIntroExtractionAllowed()) {
        const current = await getCall(callsDir(), summary.id)
        if (current?.consent?.recordOtherParty === true) {
          await setSpeakerIdentity(callsDir(), summary.id, selfIntro.key, {
            name: selfIntro.name,
            source: 'self-intro',
            confidence: 'medium'
          }).catch(() => {})
        }
      }
      // Fire-and-forget, same as objection mining above — never block the save.
      // Fully resolves multichannel calls (channel 0/1 are deterministic);
      // mono calls only get "me" once coaching supplies repSpeaker (see below).
      void resolveAndSaveIdentities({ calls: callsDir(), contacts: contactsDir() }, summary.id)
        .then(() => runFullAutoContactIntelligence(summary.id))
        .catch(() => {})
      // M25 — same fire-and-forget convention, own independent chain (not
      // .then()-ed onto the identity/contact one above): a Sales Brain
      // failure must never be able to affect contact resolution, and vice
      // versa. No-ops instantly if the feature is off (see its own gate).
      void runMemoryExtractionForCall(summary.id).catch(() => {})
      return summary
    }
  )
  ipcMain.handle('calls:delete', async (_event, id: string) => {
    // Capture the attachment list BEFORE the tombstone strips it, so any
    // blobs uploaded to the cloud bucket can be queued for deletion too.
    const existing = await getCall(callsDir(), id)
    const blobs = (existing?.attachments ?? []).map((a) => ({ id: a.id, ext: a.ext }))
    const res = await deleteCall(callsDir(), id)
    if (res.ok && blobs.length) queueAttachmentBlobDeletes(blobs)
    // The review queue stages verbatim buyer quotes mined from this call —
    // deleting the call must take them with it, or "a deleted call keeps no
    // buyer words" (deleteCall's guarantee) would be false one folder over.
    await purgeQueueForCall(objectionQueueDir(), id).catch(() => 0)
    scheduleBackup() // propagate the deletion tombstone
    return res
  })

  // --- Attachments ---------------------------------------------------------
  ipcMain.handle(
    'calls:addAttachment',
    (_event, callId: string, file: { name?: string; ext?: string; data?: ArrayBuffer }) => {
      const bytes = file?.data instanceof ArrayBuffer ? new Uint8Array(file.data) : new Uint8Array()
      return addAttachment(callsDir(), callId, { name: file?.name, ext: file?.ext, bytes })
    }
  )
  ipcMain.handle('calls:removeAttachment', async (_event, callId: string, attachmentId: string) => {
    const call = await getCall(callsDir(), callId)
    const att = call?.attachments?.find((a) => a.id === attachmentId)
    const res = await removeAttachment(callsDir(), callId, attachmentId)
    // Removing locally also removes the cloud copy (if one was ever uploaded).
    if (res.ok && att) queueAttachmentBlobDeletes([{ id: att.id, ext: att.ext }])
    return res
  })

  // --- CRM: link this call to a contact -------------------------------------
  ipcMain.handle('calls:setContact', async (_event, callId: string, contactId: string | null) => {
    const call = await setCallContact(callsDir(), callId, contactId)
    scheduleBackup() // the link is metadata like a title edit
    // Fire-and-forget: never block linking on an AI call. Only does anything
    // when the call already has a summary or transcript to work from.
    if (call && contactId) void maybeGenerateCrmNote(callId).catch(() => {})
    return call
  })

  // --- M23 Workstream A: call-type override, Skill Graph, Focus Skill -------
  ipcMain.handle('calls:setCallType', async (_event, callId: string, callType: string | null) => {
    const call = await setCallCallType(callsDir(), callId, callType)
    scheduleBackup() // plain metadata, same treatment as setContact
    return call
  })

  ipcMain.handle('coach2:getProgress', async (): Promise<SkillProgress[]> => {
    const summaries = await listCalls(callsDir())
    return computeSkillProgress(
      summaries.map((s) => ({ id: s.id, createdAt: s.createdAt, skills: s.skills }))
    )
  })

  ipcMain.handle('coach2:getFocusSkill', async (): Promise<FocusSkillState | null> => {
    return loadFocusSkill()
  })

  // --- Speaker identification (M19 Task 2) -----------------------------------
  // The one write path for both an inline rename and the "remember this
  // person" checkbox — always source: 'manual', which the auto-resolution
  // cascade (resolve-for-call.ts) is guaranteed to never overwrite.
  ipcMain.handle(
    'calls:setSpeakerName',
    async (
      _event,
      callId: string,
      key: string,
      name: string | null,
      opts?: { rememberAsContactId?: string }
    ) => {
      const call = await setSpeakerIdentity(callsDir(), callId, key, {
        name,
        source: 'manual',
        confidence: 'high',
        contactId: opts?.rememberAsContactId
      })
      if (call) scheduleBackup()
      return call
    }
  )

  // --- Bookmarks ("clip this moment") ---------------------------------------
  ipcMain.handle(
    'calls:addBookmark',
    async (_event, callId: string, atMs: number, text: string) => {
      const call = await addBookmark(callsDir(), callId, atMs, text)
      scheduleBackup()
      return call
    }
  )
  ipcMain.handle('calls:removeBookmark', async (_event, callId: string, bookmarkId: string) => {
    const call = await removeBookmark(callsDir(), callId, bookmarkId)
    scheduleBackup()
    return call
  })

  // --- AI summaries --------------------------------------------------------
  // M26 Phase 3 — an INTERACTIVE-lane job, not an inline blocking call: the
  // work always finished and saved regardless of navigation (it runs in
  // main either way), but the button's own spinner/error UI used to vanish
  // the instant you left the call, so you couldn't tell it had finished
  // without reopening it. The extraction/save logic itself is unchanged —
  // moved as-is from this handler's body into the executor below. Also used
  // fire-and-forget by the AI Note Taker auto-summarize path
  // (useTranscription.ts), which never reads the return value — enqueuing
  // and returning a jobId immediately is transparent to that caller.
  getJobManager().registerType<{ callId: string }, string>({
    type: SUMMARIZE_JOB_TYPE,
    lane: 'INTERACTIVE',
    titleFor: () => 'Summarizing call',
    targetRefFor: (i) => i.callId,
    executor: {
      kind: 'inline-async',
      run: async (input) => {
        const call = await getCall(callsDir(), input.callId)
        if (!call) throw new Error('Call not found.')
        if (!call.segments?.length) throw new Error('This call has no transcript to summarize.')
        const text = speechSegments(call.segments)
          .map((s) => `Speaker ${s.speaker + 1}: ${s.text}`)
          .join('\n')
        const result = await summarize({ kind: 'text', text })
        if (!result.ok) {
          throw Object.assign(new Error(result.message ?? 'Could not generate the summary.'), {
            code: result.error
          })
        }
        const saved = await setCallSummary(callsDir(), input.callId, result.summary)
        if (!saved) throw new Error('The summary could not be saved. Please try again.')
        scheduleBackup() // the summary (paraphrase, not the transcript) syncs
        // Fire-and-forget: only does anything if this call is ALREADY linked
        // to a contact (the other trigger, above, covers the reverse order).
        void maybeGenerateCrmNote(input.callId).catch(() => {})
        return input.callId
      }
    }
  })

  ipcMain.handle(
    'summary:call',
    async (_event, callId: string): Promise<{ ok: boolean; jobId?: string }> => {
      const manager = getJobManager()
      const already = manager
        .list()
        .find(
          (j: Job) =>
            j.type === SUMMARIZE_JOB_TYPE &&
            j.targetRef === callId &&
            (j.state === 'running' || j.state === 'queued')
        )
      if (already) return { ok: true, jobId: already.id }
      const job = manager.enqueue(SUMMARIZE_JOB_TYPE, { callId })
      return { ok: true, jobId: job.id }
    }
  )

  ipcMain.handle(
    'summary:attachment',
    async (_event, callId: string, attachmentId: string): Promise<SummaryResult> => {
      try {
        const file = await readAttachment(callsDir(), callId, attachmentId)
        if (!file) return { ok: false, error: 'failed', message: 'File not found.' }

        let input: SummarizeInput
        if (file.ext === 'pdf') {
          input = { kind: 'pdf', base64: file.bytes.toString('base64') }
        } else if (file.ext === 'docx') {
          const text = await extractDocxText(file.bytes)
          if (text === null) {
            return {
              ok: false,
              error: 'failed',
              message: "This .docx file appears to be corrupt or isn't a valid Word document."
            }
          }
          if (!text.trim()) {
            return {
              ok: false,
              error: 'failed',
              message: 'Could not read any text from this .docx file.'
            }
          }
          input = { kind: 'text', text }
        } else {
          const text = file.bytes.toString('utf8')
          if (!looksLikeText(text)) {
            return {
              ok: false,
              error: 'failed',
              message: "This file doesn't look like readable text."
            }
          }
          input = { kind: 'text', text }
        }

        const result = await summarize(input)
        if (result.ok) {
          const saved = await setAttachmentSummary(callsDir(), callId, attachmentId, result.summary)
          if (!saved) return SAVE_FAILED
        }
        return result
      } catch {
        return SAVE_FAILED
      }
    }
  )

  // --- AI coaching ---------------------------------------------------------
  // M26 Phase 3 — same shift as AI summary above: an INTERACTIVE-lane job
  // instead of an inline blocking call. The scoring/save/cascade logic is
  // unchanged, moved as-is into the executor.
  getJobManager().registerType<{ callId: string }, string>({
    type: COACH_JOB_TYPE,
    lane: 'INTERACTIVE',
    titleFor: () => 'Coaching call',
    targetRefFor: (i) => i.callId,
    executor: {
      kind: 'inline-async',
      run: async (input) => {
        const call = await getCall(callsDir(), input.callId)
        if (!call) throw new Error('Call not found.')
        if (!call.segments?.length) throw new Error('This call has no transcript to coach.')
        // M23 — sticky per call: a prior manual override always wins over
        // re-detecting from the title (setCallTypeIfUnset below only writes
        // this back when it was still unset).
        const callType = call.callType ?? detectCallType(call.title)
        const coach2Enabled = loadAppSettings().coach2.enabled
        // Read BEFORE coaching runs — this is what the rep was asked to
        // practice going INTO this call (set after the PREVIOUS call), not
        // what gets selected after this one. See FocusSkillAtCoaching's doc.
        const priorFocus = coach2Enabled ? await loadFocusSkill() : null
        // M25 Phase 3 (L3 procedural memory) — personal talk-ratio/question-
        // count norms from the rep's own past calls of the SAME call type,
        // only when Sales Brain is on. personal-benchmarks.ts's own
        // MIN_SAMPLE_SIZE floor means this stays undefined (→ exact today's-
        // behavior population defaults) until there's genuinely enough
        // history — never a confidently-wrong personalization from 1-2 calls.
        const personalBenchmarks = isSalesBrainEnabled()
          ? await computePersonalBenchmarksForCallType(callType)
          : undefined
        const result = await coachCall(speechSegments(call.segments), call.durationMs, {
          callType,
          commitments: call.commitments,
          personalBenchmarks
        })
        if (!result.ok) {
          throw Object.assign(new Error(result.message ?? 'Could not coach this call.'), {
            code: result.error
          })
        }
        if (priorFocus) {
          result.report.focusSkillAtCoaching = {
            skill: priorFocus.skill,
            microBehavior: priorFocus.microBehavior
          }
        }
        const saved = await setCallCoaching(callsDir(), input.callId, result.report)
        if (!saved) throw new Error('The coaching report could not be saved. Please try again.')
        scheduleBackup() // quote-free scores/advice sync; evidence quotes never do
        // repSpeaker is only known from here on for a mono call — re-run so
        // its "me" key (and therefore single-other-party detection) can
        // resolve for the first time.
        void resolveAndSaveIdentities({ calls: callsDir(), contacts: contactsDir() }, input.callId)
          .then(() => runFullAutoContactIntelligence(input.callId))
          .catch(() => {})
        // M25 — also re-run after coaching, same reasoning as the identity
        // cascade above: this call may have just gotten scorecard/skill
        // data it didn't have at save time, and a mono call's contactId may
        // only be known from here on. saveCandidate()'s dedupe makes a
        // second pass over the same transcript cheap/safe, not duplicate work.
        void runMemoryExtractionForCall(input.callId).catch(() => {})
        if (coach2Enabled) {
          void setCallTypeIfUnset(callsDir(), input.callId, callType).catch(() => {})
          void updateFocusSkillAfterCoaching(input.callId).catch(() => {})
        }
        return input.callId
      }
    }
  })

  ipcMain.handle(
    'coach:call',
    async (_event, callId: string): Promise<{ ok: boolean; jobId?: string }> => {
      const manager = getJobManager()
      const already = manager
        .list()
        .find(
          (j: Job) =>
            j.type === COACH_JOB_TYPE &&
            j.targetRef === callId &&
            (j.state === 'running' || j.state === 'queued')
        )
      if (already) return { ok: true, jobId: already.id }
      const job = manager.enqueue(COACH_JOB_TYPE, { callId })
      return { ok: true, jobId: job.id }
    }
  )

  // --- Commitments (§4.7) — who promised what -------------------------------
  ipcMain.handle(
    'commitments:extract',
    async (_event, callId: string): Promise<CommitmentResult> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
        const result = await extractCommitments(speechSegments(call.segments))
        if (result.ok) {
          const saved = await setCallCommitments(callsDir(), callId, result.commitments)
          if (!saved) {
            return {
              ok: false,
              error: 'failed',
              message: 'The commitments could not be saved. Please try again.'
            }
          }
        }
        return result
      } catch {
        return {
          ok: false,
          error: 'failed',
          message: 'The commitments could not be saved. Please try again.'
        }
      }
    }
  )

  // --- M24 §8 — save the Radar Report source data onto the just-saved call --
  // No AI call here (unlike commitments:extract above) — the renderer already
  // has the full nudge/health-score history from its own in-memory engine by
  // the time the call is saved; this just persists it, sanitized, same
  // "never trust a renderer-supplied blob" posture setCallCommitments takes.
  ipcMain.handle(
    'dealIntelligence:saveRecord',
    async (_event, callId: unknown, record: unknown): Promise<{ ok: boolean }> => {
      if (typeof callId !== 'string') return { ok: false }
      const saved = await setCallDealIntelligence(callsDir(), callId, record)
      return { ok: saved !== null }
    }
  )

  // --- Objection Library: mine a call for raw candidates --------------------
  // Gated on the SAME toggle that will later gate new-call mining + the
  // manual "scan past calls" trigger — nothing here runs while it's off.
  ipcMain.handle(
    'objections:mineTest',
    async (_event, callId: string): Promise<ObjectionMiningResult> => {
      if (!isObjectionMiningEnabled()) {
        return {
          ok: false,
          error: 'disabled',
          message: 'Turn on "Learn objection responses from my calls" in Settings first.'
        }
      }
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, error: 'failed', message: 'Call not found.' }
        if (!call.segments?.length) {
          return { ok: false, error: 'failed', message: 'This call has no transcript to mine.' }
        }
        return await mineObjections(speechSegments(call.segments))
      } catch {
        return {
          ok: false,
          error: 'failed',
          message: 'Something went wrong while mining this call. Please try again.'
        }
      }
    }
  )

  // Send raw mined candidates (from objections:mineTest) into the review
  // queue. Still gated on the toggle — the whole mining workflow is off
  // when the setting is off, not just the first step of it.
  ipcMain.handle(
    'objections:enqueue',
    async (
      _event,
      callId: string,
      candidates: unknown
    ): Promise<{ ok: boolean; added: number }> => {
      if (!isObjectionMiningEnabled()) return { ok: false, added: 0 }
      try {
        const call = await getCall(callsDir(), callId)
        if (!call) return { ok: false, added: 0 }
        // Never trust the renderer's "verified" booleans — re-run the same
        // transcript check mining used, against THIS call's segments. This
        // also catches candidates mined from one call but enqueued under
        // another call's id.
        const verify = makeVerifier(speechSegments(call.segments))
        const list = (Array.isArray(candidates) ? candidates : []).map((raw) => {
          if (!raw || typeof raw !== 'object') return raw
          const c = raw as Record<string, unknown>
          return {
            ...c,
            objectionVerified: verify(c.objectionQuote, c.objectionSpeaker),
            responseVerified: verify(c.responseQuote, c.responseSpeaker)
          }
        })
        const items = await addToQueue(objectionQueueDir(), list, callId, call.title)
        // The call HAS been mined (via mineTest) — mark it so the past-calls
        // scan doesn't mine it again and duplicate these candidates.
        await setCallObjectionsMined(callsDir(), callId)
        return { ok: true, added: items.length }
      } catch {
        return { ok: false, added: 0 }
      }
    }
  )

  // M26 Phase 3 — registered once here rather than at module load, since it
  // needs the shared JobManager, which main/index.ts creates and sets
  // before calling registerCalls() (see jobs/instance.ts). The mining logic
  // itself (mineCallIntoQueue -> mineObjections -> addToQueue) is completely
  // unchanged from before this migration — only its execution home (was:
  // inline inside this IPC handler, blocking the call until the whole scan
  // finished; now: a BATCH-lane job that survives the renderer navigating
  // away) and how progress/results reach the renderer (was: the handler's
  // own return value once fully done; now: real progress + a resultRef,
  // both visible in the Activity Center as the scan runs, not just at the
  // end) changed.
  //
  // Deliberately NO handle.checkpoint() here: mineCallIntoQueue already
  // marks each call objectionsMinedAt on success before moving to the next
  // one, so eligibleForMining() naturally excludes finished calls on any
  // later run -- an interrupted-then-resumed scan (or a plain Retry) just
  // recomputes "what's still eligible" fresh and continues, with no extra
  // bookkeeping needed to get that resumability for free. This is the exact
  // per-item persistence the Phase 0 research already flagged as this
  // operation's own existing resume story.
  getJobManager().registerType<Record<string, never>, string>({
    type: SCAN_JOB_TYPE,
    lane: 'BATCH',
    titleFor: () => 'Scanning past calls for objections',
    executor: {
      kind: 'inline-async',
      run: async (_input, handle) => {
        const calls = await listCalls(callsDir())
        const eligible = eligibleForMining(calls)
        const itemsTotal = eligible.length
        let scanned = 0
        let candidatesAdded = 0
        let failed = 0
        let consecutiveFailures = 0
        let stopped: 'disabled' | 'errors' | undefined
        handle.reportProgress({ mode: 'determinate', itemsDone: 0, itemsTotal })
        for (const c of eligible) {
          if (handle.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          // The toggle is the HARD gate ("off means no call is ever read") —
          // honor a mid-scan flip instead of only checking once at the start.
          if (!isObjectionMiningEnabled()) {
            stopped = 'disabled'
            break
          }
          const res = await mineCallIntoQueue(c.id)
          if (res.ok) {
            scanned++
            candidatesAdded += res.added
            consecutiveFailures = 0
          } else {
            failed++
            // A run of failures means the API is down/rate-limited — stop
            // instead of burning a doomed request per remaining call. The
            // unmined calls stay eligible for a later retry.
            if (++consecutiveFailures >= 3) {
              stopped = 'errors'
              break
            }
          }
          handle.reportProgress({ mode: 'determinate', itemsDone: scanned + failed, itemsTotal })
        }
        const parts = [`Scanned ${scanned} call${scanned === 1 ? '' : 's'}`]
        parts.push(`found ${candidatesAdded} suggestion${candidatesAdded === 1 ? '' : 's'}`)
        if (failed > 0) parts.push(`${failed} failed`)
        if (stopped === 'errors') parts.push('stopped after repeated errors')
        else if (stopped === 'disabled') parts.push('stopped — toggle turned off')
        return parts.join(', ')
      }
    }
  })

  // How many past calls are eligible (have a transcript, not yet mined) —
  // shown before the user confirms the manual scan below.
  ipcMain.handle('objections:scanEstimate', async (): Promise<{ eligibleCount: number }> => {
    if (!isObjectionMiningEnabled()) return { eligibleCount: 0 }
    const calls = await listCalls(callsDir())
    return { eligibleCount: eligibleForMining(calls).length }
  })

  // The manual "scan my past calls" trigger — only ever runs when the user
  // clicks it (never automatically). Enqueues and returns immediately; the
  // renderer tracks the actual run via window.api.jobs (list/onChanged),
  // same as the Activity Center does, so it keeps working even if the
  // Objection Library screen isn't the one open when it finishes.
  ipcMain.handle('objections:scanPastCalls', async (): Promise<{ ok: boolean; jobId?: string }> => {
    if (!isObjectionMiningEnabled()) return { ok: false }
    const manager = getJobManager()
    // One scan at a time, enforced HERE (BATCH's own maxConcurrent already
    // guarantees this too, but checking explicitly means a second click
    // hands back the SAME job instead of silently queuing a redundant one
    // behind it).
    const already = manager
      .list()
      .find((j: Job) => j.type === SCAN_JOB_TYPE && (j.state === 'running' || j.state === 'queued'))
    if (already) return { ok: true, jobId: already.id }
    const job = manager.enqueue(SCAN_JOB_TYPE, {})
    return { ok: true, jobId: job.id }
  })

  // §4.6 — the instant post-call brief. Generates the brief, next steps and a
  // follow-up email, and puts the lot on the clipboard. The clipboard write
  // deliberately happens in MAIN (see post-call-brief.ts): this fires the
  // moment a call ends, when the rep is still looking at Zoom, so the renderer
  // is exactly not focused and navigator.clipboard would refuse.
  ipcMain.handle(
    'calls:postCallBrief',
    async (_event, callId: string): Promise<PostCallBriefResult> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call?.segments?.length) return { ok: false, error: 'empty-call' as const }
        return await generatePostCallBrief(speechSegments(call.segments), call.title)
      } catch {
        return { ok: false, error: 'failed' as const }
      }
    }
  )

  // AI Note Taker's auto-title feature: generate + save a title in one step.
  ipcMain.handle(
    'calls:generateTitle',
    async (_event, callId: string): Promise<GenerateTitleResult> => {
      try {
        const call = await getCall(callsDir(), callId)
        if (!call?.segments?.length) return { ok: false }
        const result = await generateCallTitle(speechSegments(call.segments))
        if (!result.ok) return result
        const saved = await setCallTitle(callsDir(), callId, result.title)
        if (!saved) return { ok: false }
        scheduleBackup() // the new title reaches the cloud like any other metadata edit
        return { ok: true, title: saved.title }
      } catch {
        return { ok: false }
      }
    }
  )
}
