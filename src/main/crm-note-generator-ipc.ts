// M23 Workstream C — IPC surface for the standalone CRM Note Generator card
// on the Contact page. Unlike Workstream B's per-call regenerateCrmNote,
// this is contact-scoped: it finds that contact's own most recent linked
// call itself, so the renderer never has to know or pass a callId.
//
// M26 Phase 3 — generation is now a real job, and this was a genuine BUG
// fix, not just an architecture migration: the drafted note AND the
// harvested KYC suggestions lived only in the card's React state, so
// navigating off the Contact page permanently discarded every unreviewed
// one, already paid for on the rep's own API key. The job now holds the AI
// output plus the rep's decisions about it (see crm-note-review.ts), so a
// reopen — even after an app restart — resumes exactly where they left off
// without re-running either AI call.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { listCalls, getCall } from './calls-fs'
import { getContact, addComment } from './contacts-fs'
import { generateCrmNote } from './crm-notes'
import { sanitizeCrmNoteLength, type CrmNoteLength } from './crm-note-length'
import { crmNoteSourceFromCall, harvestKycFacts } from './crm-note-generator'
import {
  asCrmNoteJobResult,
  withDecision,
  isFullyReviewed,
  type CrmNoteDecision,
  type CrmNoteJobResult
} from './crm-note-review'
import { applyKycField } from './kyc-apply'
import { isNoteGeneratorEnabled } from './app-settings'
import { scheduleBackup } from './backup'
import { getJobManager } from './jobs/instance'
import type { Job } from './jobs/types'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

const DISABLED_MESSAGE = 'The CRM Note Generator is off — turn it on in Settings → CRM.'
const GENERATE_JOB_TYPE = 'crmNote:generate'

async function mostRecentCallIdForContact(contactId: string): Promise<string | null> {
  const summaries = await listCalls(callsDir())
  const related = summaries
    .filter((s) => s.contactId === contactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return related[0]?.id ?? null
}

interface GenerateJobInput {
  contactId: string
  length: CrmNoteLength
}

/** Read a job's resultData back as a review-able result, or null. */
function resultOf(job: Job | null): CrmNoteJobResult | null {
  return job ? asCrmNoteJobResult(job.resultData) : null
}

/** Record one decision onto the job and, once nothing is left to review,
 *  dismiss it so reopening this contact starts clean instead of resurfacing
 *  an already-handled batch. Best-effort: a failure here never fails the
 *  actual write (the note/field is already saved by the time this runs). */
function recordDecision(jobId: string, decision: CrmNoteDecision): void {
  const manager = getJobManager()
  const result = resultOf(manager.get(jobId))
  if (!result) return
  const next = withDecision(result, decision)
  manager.setResultData(jobId, next)
  if (isFullyReviewed(next)) manager.dismiss(jobId)
}

let registered = false

export function registerCrmNoteGenerator(): void {
  if (registered) return
  registered = true

  // The two AI calls (note + KYC harvest) are unchanged, moved as-is into
  // the executor. INTERACTIVE lane, matching the other rep-is-watching-a-
  // spinner jobs. Each distinct user-facing message the old handler
  // returned survives as a thrown Error message, so the card still explains
  // WHY it couldn't draft rather than collapsing to one generic failure.
  getJobManager().registerType<GenerateJobInput, CrmNoteJobResult>({
    type: GENERATE_JOB_TYPE,
    lane: 'INTERACTIVE',
    titleFor: () => 'Drafting CRM note',
    targetRefFor: (i) => i.contactId,
    // This job's resultData holds the drafted note AND the harvested
    // suggestions until the rep has dealt with every one — automatic
    // history pruning must never delete it, or BUG-050 comes straight back.
    // It leaves via recordDecision()'s isFullyReviewed() dismiss above.
    retainUntilConsumed: true,
    executor: {
      kind: 'inline-async',
      run: async (input) => {
        if (!isNoteGeneratorEnabled()) throw new Error(DISABLED_MESSAGE)
        const contact = await getContact(contactsDir(), input.contactId)
        if (!contact) throw new Error('Contact not found.')

        const callId = await mostRecentCallIdForContact(input.contactId)
        if (!callId) throw new Error('Link a call to this contact first.')
        const call = await getCall(callsDir(), callId)
        if (!call) throw new Error('Link a call to this contact first.')

        const source = crmNoteSourceFromCall(call)
        if (!source.trim()) {
          throw new Error('This call has no transcript or summary to draft from yet.')
        }

        const [noteResult, facts] = await Promise.all([
          generateCrmNote(source, input.length),
          harvestKycFacts(source, contact)
        ])
        if (!noteResult.ok) throw new Error('Could not draft a note. Please try again.')

        return { note: noteResult.note, facts }
      }
    }
  })

  ipcMain.handle(
    'crmNoteGenerator:generate',
    async (
      _e,
      contactId: string,
      length: unknown,
      opts: unknown
    ): Promise<{ ok: boolean; jobId?: string; message?: string }> => {
      if (!isNoteGeneratorEnabled()) return { ok: false, message: DISABLED_MESSAGE }
      const manager = getJobManager()
      const force = !!(opts && typeof opts === 'object' && (opts as Record<string, unknown>).force)

      // A SUCCEEDED job counts as "already there" (same as Generate tasks,
      // unlike the other adapters): its resultData holds a draft the rep
      // may not have finished reviewing, and reopening this contact must
      // show that rather than silently re-running — and re-billing — two
      // AI calls. "Regenerate" passes force:true to bypass this.
      if (!force) {
        const already = manager
          .list()
          .find(
            (j: Job) =>
              j.type === GENERATE_JOB_TYPE &&
              j.targetRef === contactId &&
              (j.state === 'running' || j.state === 'queued' || j.state === 'succeeded')
          )
        if (already) return { ok: true, jobId: already.id }
      }

      const job = manager.enqueue(GENERATE_JOB_TYPE, {
        contactId,
        length: sanitizeCrmNoteLength(length)
      })
      return { ok: true, jobId: job.id }
    }
  )

  ipcMain.handle(
    'crmNoteGenerator:save',
    async (_e, contactId: string, note: string, jobId?: string): Promise<{ ok: boolean }> => {
      try {
        if (!isNoteGeneratorEnabled()) return { ok: false }
        const text = typeof note === 'string' ? note.trim() : ''
        if (!text) return { ok: false }
        const contact = await addComment(contactsDir(), contactId, text, 'ai')
        if (contact) scheduleBackup()
        // Only after the write actually landed — a failed save must leave
        // the note outstanding so the rep can retry it.
        if (contact && jobId) recordDecision(jobId, { kind: 'note-handled' })
        return { ok: !!contact }
      } catch {
        return { ok: false }
      }
    }
  )

  ipcMain.handle(
    'crmNoteGenerator:applyFact',
    async (
      _e,
      contactId: string,
      field: string,
      text: string,
      jobId?: string,
      factId?: string
    ): Promise<{ ok: boolean }> => {
      try {
        if (!isNoteGeneratorEnabled()) return { ok: false }
        const contact = await applyKycField(contactsDir(), contactId, field, text)
        if (contact) scheduleBackup()
        if (contact && jobId && factId) {
          recordDecision(jobId, { kind: 'fact-accepted', factId })
        }
        return { ok: !!contact }
      } catch {
        return { ok: false }
      }
    }
  )

  // Skipping writes nothing to the contact — it is purely a review
  // decision, so unlike save/applyFact it has no other work to do.
  ipcMain.handle(
    'crmNoteGenerator:skipFact',
    async (_e, jobId: string, factId: string): Promise<{ ok: boolean }> => {
      try {
        if (typeof jobId !== 'string' || typeof factId !== 'string') return { ok: false }
        recordDecision(jobId, { kind: 'fact-skipped', factId })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  )

  // "Discard" on the drafted note — the rep read it and chose not to keep
  // it, which is a real decision, not an abandonment.
  ipcMain.handle(
    'crmNoteGenerator:discardNote',
    async (_e, jobId: string): Promise<{ ok: boolean }> => {
      try {
        if (typeof jobId !== 'string') return { ok: false }
        recordDecision(jobId, { kind: 'note-handled' })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  )
}
