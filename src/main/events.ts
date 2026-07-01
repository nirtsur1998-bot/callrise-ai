import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  setEventSync,
  type CalendarEvent,
  type EventCreateInput,
  type EventUpdateInput
} from './events-fs'
import { isGoogleSyncEnabled, pushInsertEvent } from './google'

function eventsDir(): string {
  return join(app.getPath('userData'), 'events')
}

/** Tell every window the events on disk changed, so the calendar re-reads. Used
 *  after a background push stamps the Google link, so the pulled copy dedups. */
function notifyEventsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('events:changed')
  }
}

/**
 * Push a newly-created local event to Google (best-effort, off the critical
 * path). The local write already succeeded and was returned to the renderer;
 * this only records how the mirror went. Never throws.
 */
async function syncCreate(event: CalendarEvent): Promise<void> {
  if (!(await isGoogleSyncEnabled())) {
    await setEventSync(eventsDir(), event.id, { sync: { state: 'local-only' } })
    return
  }
  const res = await pushInsertEvent(event)
  if (res.ok) {
    await setEventSync(eventsDir(), event.id, {
      provider: res.provider,
      externalId: res.externalId,
      googleUpdatedAt: res.googleUpdatedAt,
      sync: { state: 'synced', lastPushedAt: new Date().toISOString() }
    })
    notifyEventsChanged() // the event now carries externalId → dedup the pulled copy
  } else {
    await setEventSync(eventsDir(), event.id, {
      sync: { state: res.retryable ? 'dirty' : 'error', lastError: res.error }
    })
  }
}

let registered = false

export function registerEvents(): void {
  if (registered) return
  registered = true

  ipcMain.handle('events:list', (): Promise<CalendarEvent[]> => listEvents(eventsDir()))
  ipcMain.handle('events:create', async (_e, input: EventCreateInput) => {
    const event = await createEvent(eventsDir(), input) // local truth first — always succeeds
    void syncCreate(event) // fire-and-forget: offline/errors never block the local create
    return event
  })
  ipcMain.handle('events:update', (_e, id: string, patch: EventUpdateInput) =>
    updateEvent(eventsDir(), id, patch)
  )
  ipcMain.handle('events:delete', (_e, id: string) => deleteEvent(eventsDir(), id))
}
