import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { saveCall, listCalls, getCall, deleteCall, type CallSaveInput } from './calls-fs'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}

let registered = false

export function registerCalls(): void {
  if (registered) return
  registered = true

  ipcMain.handle('calls:list', () => listCalls(callsDir()))
  ipcMain.handle('calls:get', (_event, id: string) => getCall(callsDir(), id))
  ipcMain.handle('calls:save', (_event, input: CallSaveInput) => saveCall(callsDir(), input))
  ipcMain.handle('calls:delete', (_event, id: string) => deleteCall(callsDir(), id))
}
