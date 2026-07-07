import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createEntry,
  listEntries,
  updateEntry,
  deleteEntry,
  type KnowledgeEntry,
  type KnowledgeCreateInput,
  type KnowledgeUpdateInput
} from './knowledge-fs'
import { previewKnowledgeContext, type KnowledgeContextPreview } from './knowledge-context'
import { scheduleBackup } from './backup'

function knowledgeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

let registered = false

export function registerKnowledge(): void {
  if (registered) return
  registered = true

  ipcMain.handle('knowledge:list', (): Promise<KnowledgeEntry[]> => listEntries(knowledgeDir()))
  // Each mutation schedules a backup push, like calls/tasks/events — the push
  // itself only includes knowledge when its opt-in sync toggle is on.
  ipcMain.handle('knowledge:create', async (_event, input: KnowledgeCreateInput) => {
    const entry = await createEntry(knowledgeDir(), input)
    if (entry) scheduleBackup()
    return entry
  })
  ipcMain.handle('knowledge:update', async (_event, id: string, patch: KnowledgeUpdateInput) => {
    const entry = await updateEntry(knowledgeDir(), id, patch)
    if (entry) scheduleBackup()
    return entry
  })
  ipcMain.handle('knowledge:delete', async (_event, id: string) => {
    const res = await deleteEntry(knowledgeDir(), id)
    scheduleBackup()
    return res
  })

  // Shows exactly what text Claude would be given as context, plus a rough
  // size estimate — so the user can see the assembled block and catch it
  // before it grows too large for the simple "stuff it all in" approach.
  ipcMain.handle('knowledge:preview', async (): Promise<KnowledgeContextPreview> => {
    const entries = await listEntries(knowledgeDir())
    return previewKnowledgeContext(entries)
  })
}
