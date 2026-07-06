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

function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

/** A deal's stageId must reference a real, current stage — falls back to the
 *  pipeline's first stage if missing/unrecognized (never an orphaned id). */
function resolveStageId(input: unknown): string {
  const stages = loadDealStages()
  const requested = typeof input === 'string' ? input : undefined
  const match = requested ? stages.find((s) => s.id === requested) : undefined
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
  ipcMain.handle('deals:create', (_event, input: DealCreateInput) =>
    createDeal(dealsDir(), { ...input, stageId: resolveStageId(input?.stageId) })
  )
  ipcMain.handle('deals:update', (_event, id: string, patch: DealUpdateInput) => {
    const resolved: DealUpdateInput =
      'stageId' in patch ? { ...patch, stageId: resolveStageId(patch.stageId) } : patch
    return updateDeal(dealsDir(), id, resolved)
  })
  ipcMain.handle('deals:delete', (_event, id: string) => deleteDeal(dealsDir(), id))

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
