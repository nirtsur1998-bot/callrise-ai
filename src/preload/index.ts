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
    start: (options: { sampleRate: number }) => ipcRenderer.invoke('transcription:start', options),
    sendAudio: (chunk: ArrayBuffer) => ipcRenderer.send('transcription:audio', chunk),
    stop: () => ipcRenderer.invoke('transcription:stop'),
    onState: (cb: (payload: unknown) => void) => subscribe('transcription:state', cb),
    onTranscript: (cb: (payload: unknown) => void) => subscribe('transcription:transcript', cb),
    onError: (cb: (payload: unknown) => void) => subscribe('transcription:error', cb),
    onUtteranceEnd: (cb: (payload: unknown) => void) => subscribe('transcription:utteranceEnd', cb),
    onClosed: (cb: (payload: unknown) => void) => subscribe('transcription:closed', cb)
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
    delete: (id: string) => ipcRenderer.invoke('events:delete', id)
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
