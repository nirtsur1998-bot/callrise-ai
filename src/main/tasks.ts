import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createTask,
  listTasks,
  updateTask,
  deleteTask,
  type Task,
  type TaskCreateInput,
  type TaskUpdateInput
} from './tasks-fs'
import { getCall, speechSegments } from './calls-fs'
import { listDeals } from './deals-fs'
import { loadDealStages } from './deal-stages'
import { generateTasks, type ProposedTask } from './generate-tasks'
import { scheduleBackup } from './backup'
import { getJobManager } from './jobs/instance'
import type { Job } from './jobs/types'

function tasksDir(): string {
  return join(app.getPath('userData'), 'tasks')
}

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

/**
 * Backfill contactId/dealId on task creation so the follow-up dashboard can
 * reliably find tasks tied to a deal/contact — never trusts a fabricated
 * contactId/dealId from the renderer as-is; only derives them from a REAL
 * callId (via the call's own contactId) when the caller didn't already
 * supply one directly (e.g. staleness.ts's follow-up task creators, which
 * know the contact/deal already).
 */
async function resolveTaskLinks(input: TaskCreateInput): Promise<TaskCreateInput> {
  let contactId = typeof input?.contactId === 'string' ? input.contactId : undefined
  const callId = typeof input?.callId === 'string' ? input.callId : undefined
  if (!contactId && callId) {
    const call = await getCall(callsDir(), callId)
    contactId = call?.contactId
  }

  let dealId = typeof input?.dealId === 'string' ? input.dealId : undefined
  if (!dealId && contactId) {
    const stages = loadDealStages()
    const openStageIds = new Set(stages.filter((s) => s.kind === 'open').map((s) => s.id))
    const deals = await listDeals(dealsDir())
    // A contact may have more than one open deal — pick the most recently
    // created as the best guess; the rep can always re-tie it via the deal.
    const openDeal = deals
      .filter((d) => d.contactId === contactId && openStageIds.has(d.stageId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    dealId = openDeal?.id
  }

  return { ...input, contactId, dealId }
}

/** Build the text we send to Claude: the summary (if any) plus the transcript. */
function buildCallText(summaryAndTranscript: {
  summary?: { executive: string; keyPoints: string[]; actionItems: string[] }
  segments: { speaker: number; text: string }[]
}): string {
  const parts: string[] = []
  const { summary, segments } = summaryAndTranscript
  if (summary) {
    if (summary.executive) parts.push(`SUMMARY:\n${summary.executive}`)
    if (summary.keyPoints.length) {
      parts.push(`KEY POINTS:\n${summary.keyPoints.map((p) => `- ${p}`).join('\n')}`)
    }
    if (summary.actionItems.length) {
      parts.push(`ACTION ITEMS NOTED:\n${summary.actionItems.map((p) => `- ${p}`).join('\n')}`)
    }
  }
  parts.push(
    `TRANSCRIPT:\n${segments.map((s) => `Speaker ${s.speaker + 1}: ${s.text}`).join('\n')}`
  )
  return parts.join('\n\n')
}

let registered = false

/** M26 Phase 3 — same job type string as the old IPC channel name, matching
 *  the rest of this milestone's adapters. Kept as an actual bug fix, not
 *  just an architecture move (see docs — closing the review dialog before
 *  Save used to permanently discard already-paid-for AI output): the
 *  proposed tasks are attached to the job's own resultData the instant the
 *  AI call finishes, so the job (not the dialog) is the source of truth. */
const GENERATE_TASKS_JOB_TYPE = 'tasks:generateFromCall'

export function registerTasks(): void {
  if (registered) return
  registered = true

  ipcMain.handle('tasks:list', (): Promise<Task[]> => listTasks(tasksDir()))
  ipcMain.handle('tasks:create', async (_event, input: TaskCreateInput) => {
    const resolved = await resolveTaskLinks(input)
    const task = await createTask(tasksDir(), resolved)
    scheduleBackup() // mirror the change to the cloud (debounced, best-effort)
    return task
  })
  ipcMain.handle('tasks:update', async (_event, id: string, patch: TaskUpdateInput) => {
    const task = await updateTask(tasksDir(), id, patch)
    scheduleBackup()
    return task
  })
  ipcMain.handle('tasks:delete', async (_event, id: string) => {
    const res = await deleteTask(tasksDir(), id)
    scheduleBackup()
    return res
  })

  // Ask Claude for suggested tasks from a saved call. Returns proposals only —
  // nothing is saved until the user reviews and accepts them via tasks:create.
  // The extraction logic itself is unchanged, moved as-is into the executor.
  getJobManager().registerType<{ callId: string }, { tasks: ProposedTask[] }>({
    type: GENERATE_TASKS_JOB_TYPE,
    lane: 'INTERACTIVE',
    titleFor: () => 'Generating tasks',
    targetRefFor: (i) => i.callId,
    targetKind: 'call',
    // This job's resultData holds the proposed tasks until the rep saves or
    // regenerates them — automatic history pruning must never delete it, or
    // BUG-048 comes straight back (already-paid-for AI output silently
    // gone). It leaves via the dismiss in GenerateTasksDialog's save path.
    retainUntilConsumed: true,
    // BUG-060 — earned: handle.signal is threaded into generateTasks below.
    cancellable: true,
    executor: {
      kind: 'inline-async',
      run: async (input, handle) => {
        const call = await getCall(callsDir(), input.callId)
        if (!call) throw new Error('Call not found.')
        if (!call.segments?.length) {
          throw new Error('This call has no transcript to generate tasks from.')
        }
        const text = buildCallText({
          summary: call.summary,
          segments: speechSegments(call.segments)
        })
        const result = await generateTasks(text, { signal: handle.signal })
        if (!result.ok) {
          throw Object.assign(new Error(result.message ?? 'Could not generate tasks.'), {
            code: result.error
          })
        }
        return { tasks: result.tasks }
      }
    }
  })

  // The rep has saved the proposals, so this job's resultData is no longer
  // the only copy of anything — it can go. A PURPOSE-BUILT channel rather
  // than the generic `jobs:dismiss`, because only this path actually knows
  // the output was consumed; the generic one is reachable from the Activity
  // Center's "Clear history", which must never be able to claim that (see
  // JobManager.dismiss, BUG-052).
  ipcMain.handle(
    'tasks:markGenerationConsumed',
    async (_event, jobId: unknown): Promise<{ ok: boolean }> => {
      if (typeof jobId !== 'string') return { ok: false }
      return { ok: getJobManager().dismiss(jobId, { consumed: true }) }
    }
  )

  ipcMain.handle(
    'tasks:generateFromCall',
    async (_event, callId: string, opts: unknown): Promise<{ ok: boolean; jobId?: string }> => {
      const manager = getJobManager()
      const force = !!(opts && typeof opts === 'object' && (opts as Record<string, unknown>).force)
      // Unlike the other Phase 3 adapters, a SUCCEEDED job also counts as
      // "already there" here — its resultData holds the last-generated,
      // not-yet-reviewed proposals, and re-opening the dialog for this call
      // should show those instead of silently re-running (and re-billing)
      // the AI call. "Regenerate"/"Try again" pass force:true to bypass
      // this and always start a fresh attempt.
      if (!force) {
        const already = manager
          .list()
          .find(
            (j: Job) =>
              j.type === GENERATE_TASKS_JOB_TYPE &&
              j.targetRef === callId &&
              (j.state === 'running' || j.state === 'queued' || j.state === 'succeeded')
          )
        if (already) return { ok: true, jobId: already.id }
      }
      const job = manager.enqueue(GENERATE_TASKS_JOB_TYPE, { callId })
      return { ok: true, jobId: job.id }
    }
  )
}
