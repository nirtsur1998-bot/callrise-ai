import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createContact,
  listContacts,
  updateContact,
  deleteContact,
  type Contact,
  type ContactCreateInput,
  type ContactUpdateInput
} from './contacts-fs'
import { loadAppSettings, saveAppSettings } from './app-settings'
import { scheduleBackup } from './backup'

function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
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
    const res = await deleteContact(contactsDir(), id)
    if (res.ok) scheduleBackup() // propagate the (PII-stripped) tombstone
    return res
  })
}
