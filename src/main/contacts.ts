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

function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

let registered = false

export function registerContacts(): void {
  if (registered) return
  registered = true

  ipcMain.handle('contacts:list', (): Promise<Contact[]> => listContacts(contactsDir()))
  ipcMain.handle('contacts:create', (_event, input: ContactCreateInput) => {
    // Auto-numbered Customer No. (Settings → CRM): only fills in a CID the
    // renderer left blank — never overwrites one the user actually typed.
    const hasCid = typeof input?.cid === 'string' && input.cid.trim()
    if (!hasCid) {
      const { crm } = loadAppSettings()
      if (crm.autoNumberCid) {
        const cid = `${crm.cidPrefix}${crm.cidNextNumber}`
        saveAppSettings({ crm: { cidNextNumber: crm.cidNextNumber + 1 } })
        return createContact(contactsDir(), { ...input, cid })
      }
    }
    return createContact(contactsDir(), input)
  })
  ipcMain.handle('contacts:update', (_event, id: string, patch: ContactUpdateInput) =>
    updateContact(contactsDir(), id, patch)
  )
  ipcMain.handle('contacts:delete', (_event, id: string) => deleteContact(contactsDir(), id))
}
