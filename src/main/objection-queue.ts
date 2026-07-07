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

export type ObjectionApproveResult = { ok: true; entry: KnowledgeEntry } | { ok: false }

/** Approvals currently in flight — a double-click lands both invokes before
 *  the first unlink, which would create the knowledge entry twice. */
const approving = new Set<string>()

let registered = false

export function registerObjectionQueue(): void {
  if (registered) return
  registered = true

  ipcMain.handle('objectionQueue:list', (): Promise<ObjectionQueueItem[]> => listQueue(queueDir()))

  // Approve as-is (no edits) or edit-then-approve (edits.trigger/response
  // override the mined quotes). Either way this is the ONLY path that ever
  // creates a real objection script — nothing else in this feature writes
  // to the Knowledge Base.
  ipcMain.handle(
    'objectionQueue:approve',
    async (_event, id: string, edits?: ObjectionApproveEdits): Promise<ObjectionApproveResult> => {
      if (typeof id !== 'string' || approving.has(id)) return { ok: false }
      approving.add(id)
      try {
        return await approveItem(id, edits)
      } finally {
        approving.delete(id)
      }
    }
  )

  async function approveItem(
    id: string,
    edits?: ObjectionApproveEdits
  ): Promise<ObjectionApproveResult> {
    const item = await getQueueItem(queueDir(), id)
    if (!item) return { ok: false }
    // An edit that clears a field is a mistake, not a request to keep the
    // mined original — reject it so the user sees an error instead of
    // silently approving text they just deleted.
    if (typeof edits?.trigger === 'string' && !edits.trigger.trim()) return { ok: false }
    if (typeof edits?.response === 'string' && !edits.response.trim()) return { ok: false }
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
    // Surface a failed unlink instead of claiming success while the item is
    // still in the queue (an approve-again would duplicate the entry).
    const removed = await removeFromQueue(queueDir(), id)
    if (!removed.ok) return { ok: false }
    return { ok: true, entry }
  }

  ipcMain.handle('objectionQueue:reject', (_event, id: string) => removeFromQueue(queueDir(), id))
}
