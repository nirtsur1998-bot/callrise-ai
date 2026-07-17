import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createContact,
  listContacts,
  updateContact,
  deleteContact,
  addComment,
  removeComment,
  type Contact,
  type ContactCreateInput,
  type ContactUpdateInput
} from './contacts-fs'
import { loadAppSettings, saveAppSettings } from './app-settings'
import { scheduleBackup } from './backup'
import { listDeals } from './deals-fs'

function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

let registered = false

export function registerContacts(): void {
  if (registered) return
  registered = true

  ipcMain.handle('contacts:list', (): Promise<Contact[]> => listContacts(contactsDir()))
  ipcMain.handle('contacts:create', async (_event, input: ContactCreateInput) => {
    // Auto-numbered Customer No. (Settings → CRM): only fills in a CID the
    // renderer left blank — never overwrites one the user actually typed.
    const hasCid = typeof input?.cid === 'string' && input.cid.trim()
    let effectiveInput = input
    if (!hasCid) {
      const { crm } = loadAppSettings()
      if (crm.autoNumberCid) {
        const cid = `${crm.cidPrefix}${crm.cidNextNumber}`
        saveAppSettings({ crm: { cidNextNumber: crm.cidNextNumber + 1 } })
        effectiveInput = { ...input, cid }
      }
    }
    const contact = await createContact(contactsDir(), effectiveInput)
    // Like calls/tasks/events: a mutation schedules a push so an edit made
    // just before quitting still reaches the cloud (not only the 10-min tick).
    if (contact) scheduleBackup()
    return contact
  })
  ipcMain.handle('contacts:update', async (_event, id: string, patch: ContactUpdateInput) => {
    const contact = await updateContact(contactsDir(), id, patch)
    if (contact) scheduleBackup()
    return contact
  })
  ipcMain.handle('contacts:delete', async (_event, id: string) => {
    // Referential integrity, mirroring stage removal: a contact still owning
    // deals can't be deleted — those deals would forever show "Unknown
    // contact" and their follow-up flags would misbehave.
    try {
      const deals = await listDeals(dealsDir())
      if (deals.some((d) => d.contactId === id)) {
        return { ok: false, reason: 'has-deals' as const }
      }
    } catch {
      /* deals unreadable — don't block the delete on a broken side-store */
    }
    const res = await deleteContact(contactsDir(), id)
    if (res.ok) scheduleBackup() // propagate the (PII-stripped) tombstone
    return res
  })

  // --- Comments --------------------------------------------------------------
  ipcMain.handle('contacts:addComment', async (_event, id: string, text: string) => {
    const contact = await addComment(contactsDir(), id, text, 'user')
    if (contact) scheduleBackup()
    return contact
  })
  ipcMain.handle('contacts:removeComment', async (_event, id: string, commentId: string) => {
    const contact = await removeComment(contactsDir(), id, commentId)
    if (contact) scheduleBackup()
    return contact
  })
}
