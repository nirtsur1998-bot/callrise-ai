import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createDeal,
  listDeals,
  updateDeal,
  deleteDeal,
  getDeal,
  setDealRiskAssessment,
  type Deal,
  type DealCreateInput,
  type DealUpdateInput
} from './deals-fs'
import { loadDealStages } from './deal-stages'
import { listCalls, getCall } from './calls-fs'
import { assessDealRisk, type DealRiskCallInput } from './deal-risk'
import { getContact } from './contacts-fs'
import { listTasks, createTask } from './tasks-fs'
import { scheduleBackup } from './backup'
import { getJobManager } from './jobs/instance'
import type { Job } from './jobs/types'

const ASSESS_RISK_JOB_TYPE = 'deals:assessRisk'

function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

function tasksDir(): string {
  return join(app.getPath('userData'), 'tasks')
}

/** Auto-suggest a follow-up task the moment a fresh assessment comes back
 *  High — mirrors the exact title/shape the manual "Create task" button on
 *  the follow-up digest already produces (staleness.ts's createFollowUpTask),
 *  so the two never produce visibly different tasks for the same situation.
 *  Best-effort: a failure here must never fail the risk assessment itself. */
async function autoCreateHighRiskTask(deal: Deal): Promise<void> {
  try {
    const contact = await getContact(contactsDir(), deal.contactId)
    const title = `Follow up with ${contact?.name ?? 'contact'} — ${deal.title}`
    const existing = await listTasks(tasksDir())
    if (existing.some((t) => t.title === title && t.status === 'open')) return
    await createTask(tasksDir(), {
      title,
      type: 'follow-up',
      priority: 'high',
      clientName: contact?.name ?? null,
      note: `Deal flagged High risk: ${deal.title}`,
      contactId: deal.contactId,
      dealId: deal.id,
      source: 'ai'
    })
  } catch {
    /* best-effort — the assessment itself already saved successfully */
  }
}

/** A deal's stageId must reference a real, current stage — falls back to the
 *  pipeline's first stage if missing/unrecognized (never an orphaned id).
 *
 *  M23 bug hunt: this substitution was completely silent — a deal move sent
 *  with a stale stageId (e.g. another window/session deleted or renamed the
 *  stage after this one last refreshed its stage list, per useDealStages
 *  only refetching on mount or a cloud-sync event, not on a local peer's
 *  edit) would land in "whatever the first stage happens to be" with zero
 *  indication anything unusual happened — the deal just quietly appears in
 *  the wrong column. Logging it doesn't fix the root refresh-staleness gap
 *  (a bigger change: either push stage-list updates cross-window, or version
 *  the stage list so a stale write can be rejected outright), but it turns
 *  an invisible data-integrity surprise into something a `--diagnose` run or
 *  a support conversation can actually trace. */
function resolveStageId(input: unknown): string {
  const stages = loadDealStages()
  const requested = typeof input === 'string' ? input : undefined
  const match = requested ? stages.find((s) => s.id === requested) : undefined
  if (requested && !match) {
    console.warn(
      `[deals] stageId "${requested}" does not match any current stage — falling back to ` +
        `"${stages[0]?.id ?? 'none'}". This usually means the stage was deleted/renamed in ` +
        `another window since this one last loaded its stage list.`
    )
  }
  return (match ?? stages[0]).id
}

/** Gather the already-computed (never raw-transcript) context the risk
 *  assessment is grounded in: each call linked to the deal's contact, with
 *  its paraphrased summary, coach score, and objection-dimension note. */
async function gatherRiskContext(contactId: string): Promise<DealRiskCallInput[]> {
  const summaries = await listCalls(callsDir())
  const matches = summaries.filter((c) => c.contactId === contactId)
  const calls = (await Promise.all(matches.map((c) => getCall(callsDir(), c.id)))).filter(
    (c): c is NonNullable<typeof c> => c !== null
  )
  calls.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return calls.map((call) => ({
    id: call.id,
    title: call.title,
    createdAt: call.createdAt,
    summary: call.summary?.executive,
    coachScore: call.coaching?.overallScore,
    objectionNote: call.coaching?.dimensions.find((d) => d.key === 'objection')?.comment
  }))
}

let registered = false

export function registerDeals(): void {
  if (registered) return
  registered = true

  ipcMain.handle('deals:list', (): Promise<Deal[]> => listDeals(dealsDir()))
  ipcMain.handle('deals:create', async (_event, input: DealCreateInput) => {
    const deal = await createDeal(dealsDir(), { ...input, stageId: resolveStageId(input?.stageId) })
    if (deal) scheduleBackup() // deals sync with the Contacts & deals toggle
    return deal
  })
  ipcMain.handle('deals:update', async (_event, id: string, patch: DealUpdateInput) => {
    // `'stageId' in patch` throws on a null/primitive patch — return null like
    // every other malformed input instead of an internal TypeError.
    if (!patch || typeof patch !== 'object') return null
    const resolved: DealUpdateInput =
      'stageId' in patch ? { ...patch, stageId: resolveStageId(patch.stageId) } : patch
    const deal = await updateDeal(dealsDir(), id, resolved)
    if (deal) scheduleBackup()
    return deal
  })
  ipcMain.handle('deals:delete', async (_event, id: string) => {
    const res = await deleteDeal(dealsDir(), id)
    if (res.ok) scheduleBackup() // propagate the tombstone
    return res
  })

  // Phase 5 Step 1: manual, per-deal AI risk assessment — never automatic.
  //
  // M26 Phase 3 — an INTERACTIVE-lane job, same as the CallDetail AI
  // buttons. The assessment logic is unchanged, moved as-is into the
  // executor. Deliberately NO resultData here (unlike Generate tasks): the
  // assessment is already written to the deal on disk via
  // setDealRiskAssessment BEFORE the job resolves, so there is no
  // review-then-save step and therefore nothing that could be lost by
  // navigating away — this is a progress-visibility migration only, not a
  // data-loss fix. The renderer refetches the deal to read the result, the
  // same way it always did.
  getJobManager().registerType<{ dealId: string }, string>({
    type: ASSESS_RISK_JOB_TYPE,
    lane: 'INTERACTIVE',
    titleFor: () => 'Assessing deal risk',
    targetRefFor: (i) => i.dealId,
    targetKind: 'deal',
    // BUG-060 — earned: handle.signal is threaded into assessDealRisk below.
    cancellable: true,
    executor: {
      kind: 'inline-async',
      run: async (input, handle) => {
        const deal = await getDeal(dealsDir(), input.dealId)
        if (!deal) throw new Error('Deal not found.')
        const stages = loadDealStages()
        const stageLabel = stages.find((s) => s.id === deal.stageId)?.label ?? 'Unknown'
        const calls = await gatherRiskContext(deal.contactId)
        const result = await assessDealRisk(
          {
            title: deal.title,
            stageLabel,
            value: deal.value,
            expectedCloseDate: deal.expectedCloseDate,
            createdAt: deal.createdAt,
            calls
          },
          { signal: handle.signal }
        )
        if (!result.ok) {
          throw Object.assign(new Error(result.message ?? 'Could not assess this deal.'), {
            code: result.error
          })
        }
        const saved = await setDealRiskAssessment(dealsDir(), input.dealId, result.assessment)
        if (!saved) throw new Error('The assessment could not be saved. Please try again.')
        if (result.assessment.level === 'high') void autoCreateHighRiskTask(saved)
        return input.dealId
      }
    }
  })

  ipcMain.handle(
    'deals:assessRisk',
    async (_event, dealId: string): Promise<{ ok: boolean; jobId?: string }> => {
      const manager = getJobManager()
      const already = manager
        .list()
        .find(
          (j: Job) =>
            j.type === ASSESS_RISK_JOB_TYPE &&
            j.targetRef === dealId &&
            (j.state === 'running' || j.state === 'queued')
        )
      if (already) return { ok: true, jobId: already.id }
      const job = manager.enqueue(ASSESS_RISK_JOB_TYPE, { dealId })
      return { ok: true, jobId: job.id }
    }
  )
}
