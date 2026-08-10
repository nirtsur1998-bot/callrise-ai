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
import { assessDealRisk, type DealRiskResult, type DealRiskCallInput } from './deal-risk'
import { getContact } from './contacts-fs'
import { listTasks, createTask } from './tasks-fs'
import { scheduleBackup } from './backup'

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
  ipcMain.handle('deals:assessRisk', async (_event, dealId: string): Promise<DealRiskResult> => {
    try {
      const deal = await getDeal(dealsDir(), dealId)
      if (!deal) return { ok: false, error: 'failed', message: 'Deal not found.' }
      const stages = loadDealStages()
      const stageLabel = stages.find((s) => s.id === deal.stageId)?.label ?? 'Unknown'
      const calls = await gatherRiskContext(deal.contactId)
      const result = await assessDealRisk({
        title: deal.title,
        stageLabel,
        value: deal.value,
        expectedCloseDate: deal.expectedCloseDate,
        createdAt: deal.createdAt,
        calls
      })
      if (result.ok) {
        const saved = await setDealRiskAssessment(dealsDir(), dealId, result.assessment)
        if (!saved) {
          return {
            ok: false,
            error: 'failed',
            message: 'The assessment could not be saved. Please try again.'
          }
        }
        if (result.assessment.level === 'high') void autoCreateHighRiskTask(saved)
      }
      return result
    } catch {
      return {
        ok: false,
        error: 'failed',
        message: 'The assessment could not be saved. Please try again.'
      }
    }
  })
}
