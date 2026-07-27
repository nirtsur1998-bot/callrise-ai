import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { DetectedCall, DetectorEvent, DetectorState } from '../main/detection/types'

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
    start: (options: { sampleRate: number; multichannel?: boolean; expectedSessionId?: number }) =>
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
    coachCall: (callId: string) => ipcRenderer.invoke('coach:call', callId),
    mineObjectionsTest: (callId: string) => ipcRenderer.invoke('objections:mineTest', callId),
    enqueueObjections: (callId: string, candidates: unknown) =>
      ipcRenderer.invoke('objections:enqueue', callId, candidates),
    objectionScanEstimate: () => ipcRenderer.invoke('objections:scanEstimate'),
    scanPastCallsForObjections: () => ipcRenderer.invoke('objections:scanPastCalls'),
    generateTitle: (callId: string) => ipcRenderer.invoke('calls:generateTitle', callId),
    setContact: (callId: string, contactId: string | null) =>
      ipcRenderer.invoke('calls:setContact', callId, contactId),
    addBookmark: (callId: string, atMs: number, text: string) =>
      ipcRenderer.invoke('calls:addBookmark', callId, atMs, text),
    removeBookmark: (callId: string, bookmarkId: string) =>
      ipcRenderer.invoke('calls:removeBookmark', callId, bookmarkId),
    exportCoachingPdf: (callId: string) => ipcRenderer.invoke('coach:exportPdf', callId)
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (input: unknown) => ipcRenderer.invoke('tasks:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('tasks:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    generateFromCall: (callId: string) => ipcRenderer.invoke('tasks:generateFromCall', callId)
  },
  contacts: {
    list: () => ipcRenderer.invoke('contacts:list'),
    create: (input: unknown) => ipcRenderer.invoke('contacts:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('contacts:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('contacts:delete', id),
    addComment: (id: string, text: string) => ipcRenderer.invoke('contacts:addComment', id, text),
    removeComment: (id: string, commentId: string) =>
      ipcRenderer.invoke('contacts:removeComment', id, commentId)
  },
  deals: {
    list: () => ipcRenderer.invoke('deals:list'),
    create: (input: unknown) => ipcRenderer.invoke('deals:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('deals:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('deals:delete', id),
    assessRisk: (id: string) => ipcRenderer.invoke('deals:assessRisk', id)
  },
  dealStages: {
    get: () => ipcRenderer.invoke('dealStages:get'),
    set: (stages: unknown) => ipcRenderer.invoke('dealStages:set', stages)
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
    updateName: (name: string) => ipcRenderer.invoke('auth:updateName', { name }),
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
    // Reveal the first .conflict file in Finder (kept two-device edit copies).
    revealConflicts: () => ipcRenderer.invoke('backup:revealConflicts'),
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
  },
  outlook: {
    getStatus: () => ipcRenderer.invoke('outlook:getStatus'),
    connect: () => ipcRenderer.invoke('outlook:connect'),
    connectWrite: () => ipcRenderer.invoke('outlook:connectWrite'),
    disconnect: () => ipcRenderer.invoke('outlook:disconnect'),
    listCalendars: () => ipcRenderer.invoke('outlook:listCalendars'),
    pullEvents: () => ipcRenderer.invoke('outlook:pullEvents'),
    cachedEvents: () => ipcRenderer.invoke('outlook:cachedEvents')
  },
  aiKeys: {
    getStatus: () => ipcRenderer.invoke('aiKeys:getStatus'),
    save: (name: 'DEEPGRAM_API_KEY' | 'ANTHROPIC_API_KEY', value: string) =>
      ipcRenderer.invoke('aiKeys:save', name, value),
    clear: (name: 'DEEPGRAM_API_KEY' | 'ANTHROPIC_API_KEY') =>
      ipcRenderer.invoke('aiKeys:clear', name)
  },
  virtualmic: {
    // App-managed noise cancellation: detect + start/stop the denoiser helper.
    getStatus: () => ipcRenderer.invoke('virtualmic:getStatus'),
    start: () => ipcRenderer.invoke('virtualmic:start'),
    stop: () => ipcRenderer.invoke('virtualmic:stop'),
    // One-click install of the HAL driver — still needs the OS's own admin
    // password prompt (unavoidable for a system audio device), but no terminal.
    installDriver: () => ipcRenderer.invoke('virtualmic:installDriver'),
    // Fires when the helper's running/denoise state changes (started, stopped, crashed).
    onChanged: (cb: (status: unknown) => void) => subscribe('virtualmic:changed', cb)
  },
  knowledge: {
    list: () => ipcRenderer.invoke('knowledge:list'),
    create: (input: unknown) => ipcRenderer.invoke('knowledge:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('knowledge:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('knowledge:delete', id),
    preview: () => ipcRenderer.invoke('knowledge:preview')
  },
  objectionQueue: {
    list: () => ipcRenderer.invoke('objectionQueue:list'),
    approve: (id: string, edits?: unknown) =>
      ipcRenderer.invoke('objectionQueue:approve', id, edits),
    reject: (id: string) => ipcRenderer.invoke('objectionQueue:reject', id)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: unknown) => ipcRenderer.invoke('settings:update', patch),
    previewPersonalization: () => ipcRenderer.invoke('settings:previewPersonalization')
  },
  app: {
    getLaunchAtLogin: () => ipcRenderer.invoke('app:getLaunchAtLogin'),
    setLaunchAtLogin: (value: boolean) => ipcRenderer.invoke('app:setLaunchAtLogin', value),
    getActiveApp: () => ipcRenderer.invoke('app:getActiveApp'),
    getLastExternalApp: () => ipcRenderer.invoke('app:getLastExternalApp'),
    onCallDetected: (cb: (appName: string) => void) => subscribe('app:callDetected', cb),
    isPackaged: () => ipcRenderer.invoke('app:isPackaged')
  },
  detection: {
    getState: () => ipcRenderer.invoke('detection:getState') as Promise<DetectorState | undefined>,
    captureStarted: (payload: { callId: string; sessionId: string }) =>
      ipcRenderer.invoke('detection:captureStarted', payload),
    captureFailed: (payload: { callId: string }) =>
      ipcRenderer.invoke('detection:captureFailed', payload),
    respondToDetection: (decision: 'accept' | 'decline') =>
      ipcRenderer.invoke('detection:respondToDetection', decision),
    respondToSwitch: (decision: 'switch' | 'keep') =>
      ipcRenderer.invoke('detection:respondToSwitch', decision),
    pause: () => ipcRenderer.invoke('detection:pause'),
    resume: () => ipcRenderer.invoke('detection:resume'),
    stop: () => ipcRenderer.invoke('detection:stop'),
    snooze: (minutes: number) => ipcRenderer.invoke('detection:snooze', minutes),
    onStateChanged: (cb: (payload: { state: DetectorState }) => void) =>
      subscribe('detection:state-changed', cb),
    onEvent: (cb: (event: DetectorEvent) => void) => subscribe('detection:event', cb),
    onCallDetected: (cb: (call: DetectedCall) => void) => subscribe('detection:call-detected', cb),
    onSwitchOffered: (cb: (payload: { current: DetectedCall; pending: DetectedCall }) => void) =>
      subscribe('detection:switch-offered', cb),
    onStartCapture: (cb: (payload: { call: DetectedCall; mode: 'full' | 'mic-only' }) => void) =>
      subscribe('detection:startCapture', cb)
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
