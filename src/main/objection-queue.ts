import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  listQueue,
  getQueueItem,
  removeFromQueue,
  type ObjectionQueueItem
} from './objection-queue-fs'
import { createEntry, type KnowledgeEntry } from './knowledge-fs'

function queueDir(): string {
  return join(app.getPath('userData'), 'objection-queue')
}

function knowledgeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

export interface ObjectionApproveEdits {
  trigger?: string
  response?: string
}

export type ObjectionApproveResult =
  | { ok: true; entry: KnowledgeEntry }
  | { ok: false }

let registered = false

export function registerObjectionQueue(): void {
  if (registered) return
  registered = true

  ipcMain.handle(
    'objectionQueue:list',
    (): Promise<ObjectionQueueItem[]> => listQueue(queueDir())
  )

  // Approve as-is (no edits) or edit-then-approve (edits.trigger/response
  // override the mined quotes). Either way this is the ONLY path that ever
  // creates a real objection script — nothing else in this feature writes
  // to the Knowledge Base.
  ipcMain.handle(
    'objectionQueue:approve',
    async (_event, id: string, edits?: ObjectionApproveEdits): Promise<ObjectionApproveResult> => {
      const item = await getQueueItem(queueDir(), id)
      if (!item) return { ok: false }
      const trigger =
        typeof edits?.trigger === 'string' && edits.trigger.trim()
          ? edits.trigger
          : item.objectionQuote
      const response =
        typeof edits?.response === 'string' && edits.response.trim()
          ? edits.response
          : item.responseQuote
      const entry = await createEntry(knowledgeDir(), { category: 'objection', trigger, response })
      if (!entry) return { ok: false }
      await removeFromQueue(queueDir(), id)
      return { ok: true, entry }
    }
  )

  ipcMain.handle('objectionQueue:reject', (_event, id: string) =>
    removeFromQueue(queueDir(), id)
  )
}
