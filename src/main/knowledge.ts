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

function knowledgeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

let registered = false

export function registerKnowledge(): void {
  if (registered) return
  registered = true

  ipcMain.handle('knowledge:list', (): Promise<KnowledgeEntry[]> => listEntries(knowledgeDir()))
  ipcMain.handle('knowledge:create', (_event, input: KnowledgeCreateInput) =>
    createEntry(knowledgeDir(), input)
  )
  ipcMain.handle('knowledge:update', (_event, id: string, patch: KnowledgeUpdateInput) =>
    updateEntry(knowledgeDir(), id, patch)
  )
  ipcMain.handle('knowledge:delete', (_event, id: string) => deleteEntry(knowledgeDir(), id))

  // Shows exactly what text Claude would be given as context, plus a rough
  // size estimate — so the user can see the assembled block and catch it
  // before it grows too large for the simple "stuff it all in" approach.
  ipcMain.handle('knowledge:preview', async (): Promise<KnowledgeContextPreview> => {
    const entries = await listEntries(knowledgeDir())
    return previewKnowledgeContext(entries)
  })
}
