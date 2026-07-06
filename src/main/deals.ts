import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createDeal,
  listDeals,
  updateDeal,
  deleteDeal,
  type Deal,
  type DealCreateInput,
  type DealUpdateInput
} from './deals-fs'
import { loadDealStages } from './deal-stages'

function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

/** A deal's stageId must reference a real, current stage — falls back to the
 *  pipeline's first stage if missing/unrecognized (never an orphaned id). */
function resolveStageId(input: unknown): string {
  const stages = loadDealStages()
  const requested = typeof input === 'string' ? input : undefined
  const match = requested ? stages.find((s) => s.id === requested) : undefined
  return (match ?? stages[0]).id
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
}
