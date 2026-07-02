import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type Unsubscribe = () => void

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => callback(payload as T)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// The narrow, typed API exposed to the renderer (see preload/index.d.ts).
const api = {
  transcription: {
    ensureMicAccess: () => ipcRenderer.invoke('mic:ensureAccess'),
    openMicSettings: () => ipcRenderer.invoke('mic:openSettings'),
    start: (options: { sampleRate: number; multichannel?: boolean }) =>
      ipcRenderer.invoke('transcription:start', options),
    sendAudio: (chunk: ArrayBuffer) => ipcRenderer.send('transcription:audio', chunk),
    stop: () => ipcRenderer.invoke('transcription:stop'),
    onState: (cb: (payload: unknown) => void) => subscribe('transcription:state', cb),
    onTranscript: (cb: (payload: unknown) => void) => subscribe('transcription:transcript', cb),
    onError: (cb: (payload: unknown) => void) => subscribe('transcription:error', cb),
    onUtteranceEnd: (cb: (payload: unknown) => void) => subscribe('transcription:utteranceEnd', cb),
    onClosed: (cb: (payload: unknown) => void) => subscribe('transcription:closed', cb),
    suggestQuestion: (text: string) => ipcRenderer.invoke('live:suggestQuestion', text),
    askCoach: (transcript: string, question: string) =>
      ipcRenderer.invoke('live:askCoach', { transcript, question }),
    liveCue: (transcript: string, repSpeaker: number | null) =>
      ipcRenderer.invoke('live:cue', { transcript, repSpeaker })
  },
  calls: {
    list: () => ipcRenderer.invoke('calls:list'),
    get: (id: string) => ipcRenderer.invoke('calls:get', id),
    save: (input: unknown) => ipcRenderer.invoke('calls:save', input),
    delete: (id: string) => ipcRenderer.invoke('calls:delete', id),
    addAttachment: (callId: string, file: { name: string; ext: string; data: ArrayBuffer }) =>
      ipcRenderer.invoke('calls:addAttachment', callId, file),
    removeAttachment: (callId: string, attachmentId: string) =>
      ipcRenderer.invoke('calls:removeAttachment', callId, attachmentId),
    summarizeCall: (callId: string) => ipcRenderer.invoke('summary:call', callId),
    summarizeAttachment: (callId: string, attachmentId: string) =>
      ipcRenderer.invoke('summary:attachment', callId, attachmentId),
    coachCall: (callId: string) => ipcRenderer.invoke('coach:call', callId)
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (input: unknown) => ipcRenderer.invoke('tasks:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('tasks:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    generateFromCall: (callId: string) => ipcRenderer.invoke('tasks:generateFromCall', callId)
  },
  events: {
    list: () => ipcRenderer.invoke('events:list'),
    create: (input: unknown) => ipcRenderer.invoke('events:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('events:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('events:delete', id),
    // Adopt a Google event as a local, editable event linked back to Google.
    adopt: (input: unknown) => ipcRenderer.invoke('events:adopt', input),
    // Delete a Google-originated event from the app (and from Google).
    deleteExternal: (link: unknown) => ipcRenderer.invoke('events:deleteExternal', link),
    // Retry any pending Google pushes/deletes (offline backlog). Fire-and-forget.
    reconcile: () => ipcRenderer.invoke('events:reconcile'),
    // Fires when a background Google sync changes events on disk (re-pull needed).
    onChanged: (cb: () => void) => subscribe('events:changed', cb)
  },
  auth: {
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
    signUp: (email: string, password: string, name?: string) =>
      ipcRenderer.invoke('auth:signUp', { email, password, name }),
    verifyOtp: (email: string, token: string) =>
      ipcRenderer.invoke('auth:verifyOtp', { email, token }),
    signIn: (email: string, password: string) =>
      ipcRenderer.invoke('auth:signIn', { email, password }),
    resendCode: (email: string) => ipcRenderer.invoke('auth:resendCode', { email }),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
    onChange: (cb: (user: unknown) => void) => subscribe('auth:changed', cb)
  },
  loopback: {
    // Synchronous so it can run in the same click tick as getDisplayMedia.
    arm: (): void => {
      ipcRenderer.sendSync('loopback:arm')
    },
    disarm: (): void => {
      ipcRenderer.sendSync('loopback:disarm')
    },
    openScreenSettings: () => ipcRenderer.invoke('loopback:openScreenSettings')
  },
  backup: {
    // Force a backup now (the "Back up now" button uses this).
    pushNow: () => ipcRenderer.invoke('backup:pushNow'),
    // Full sync: restore (pull + reconcile) then push.
    syncNow: () => ipcRenderer.invoke('backup:syncNow'),
    // Last-backed-up time / last error, for the trust UI.
    getStatus: () => ipcRenderer.invoke('backup:getStatus'),
    // Fires when a restore changed tasks/calls on disk (screens should re-read).
    onChanged: (cb: () => void) => subscribe('backup:changed', cb)
  },
  google: {
    getStatus: () => ipcRenderer.invoke('google:getStatus'),
    connect: () => ipcRenderer.invoke('google:connect'),
    connectWrite: () => ipcRenderer.invoke('google:connectWrite'),
    disconnect: () => ipcRenderer.invoke('google:disconnect'),
    listCalendars: () => ipcRenderer.invoke('google:listCalendars'),
    pullEvents: () => ipcRenderer.invoke('google:pullEvents'),
    cachedEvents: () => ipcRenderer.invoke('google:cachedEvents')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
