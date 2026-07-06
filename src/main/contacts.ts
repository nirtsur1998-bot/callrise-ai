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

function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

let registered = false

export function registerContacts(): void {
  if (registered) return
  registered = true

  ipcMain.handle('contacts:list', (): Promise<Contact[]> => listContacts(contactsDir()))
  ipcMain.handle('contacts:create', (_event, input: ContactCreateInput) =>
    createContact(contactsDir(), input)
  )
  ipcMain.handle('contacts:update', (_event, id: string, patch: ContactUpdateInput) =>
    updateContact(contactsDir(), id, patch)
  )
  ipcMain.handle('contacts:delete', (_event, id: string) => deleteContact(contactsDir(), id))
}
