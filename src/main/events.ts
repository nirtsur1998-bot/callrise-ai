import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  type CalendarEvent,
  type EventCreateInput,
  type EventUpdateInput
} from './events-fs'

function eventsDir(): string {
  return join(app.getPath('userData'), 'events')
}

let registered = false

export function registerEvents(): void {
  if (registered) return
  registered = true

  ipcMain.handle('events:list', (): Promise<CalendarEvent[]> => listEvents(eventsDir()))
  ipcMain.handle('events:create', (_e, input: EventCreateInput) => createEvent(eventsDir(), input))
  ipcMain.handle('events:update', (_e, id: string, patch: EventUpdateInput) =>
    updateEvent(eventsDir(), id, patch)
  )
  ipcMain.handle('events:delete', (_e, id: string) => deleteEvent(eventsDir(), id))
}
