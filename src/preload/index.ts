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
    start: (options: {
      sampleRate: number
      multichannel?: boolean
      expectedSessionId?: number
      producerId?: number
    }) => ipcRenderer.invoke('transcription:start', options),
    /** `producerId` names the capture pipeline this chunk came from — main
     *  refuses audio from any producer other than the one the session was
     *  started for, so a recorder that outlived its call can't feed the next
     *  one (see StartOptions.producerId in main/transcription.ts). */
    sendAudio: (chunk: ArrayBuffer, producerId?: number) =>
      ipcRenderer.send('transcription:audio', chunk, producerId),
    /** Ask main for a direct port for the audio worker (§1.4). The port itself
     *  arrives as a window message, not through this bridge — see below. */
    requestAudioPort: () => ipcRenderer.send('audio-port:request'),
    /** Ring overrun — audio the worker could not drain in time. Reported so it
     *  shows up as a gap marker instead of words that silently never existed. */
    reportAudioDropped: (frames: number, producerId?: number) =>
      ipcRenderer.send('transcription:audioDropped', frames, producerId),
    stop: () => ipcRenderer.invoke('transcription:stop'),
    onState: (cb: (payload: unknown) => void) => subscribe('transcription:state', cb),
    onTranscript: (cb: (payload: unknown) => void) => subscribe('transcription:transcript', cb),
    onError: (cb: (payload: unknown) => void) => subscribe('transcription:error', cb),
    onUtteranceEnd: (cb: (payload: unknown) => void) => subscribe('transcription:utteranceEnd', cb),
    onClosed: (cb: (payload: unknown) => void) => subscribe('transcription:closed', cb),
    onGap: (cb: (payload: unknown) => void) => subscribe('transcription:gap', cb),
    onHealth: (cb: (payload: unknown) => void) => subscribe('transcription:health', cb),
    onCaptureLost: (cb: (payload: unknown) => void) => subscribe('transcription:captureLost', cb),
    onBuyerSilent: (cb: (payload: unknown) => void) => subscribe('transcription:buyerSilent', cb),
    onCrossTalkWarning: (cb: (payload: unknown) => void) =>
      subscribe('transcription:crossTalkWarning', cb),
    /** M22 — buyer-side capture kept needing lag corrections faster than they
     *  could recover (a sustained deficit, not a one-off blip), so main
     *  dropped it and the call continues mic-only. Fired once per call. */
    onMultichannelFallback: (cb: (payload: unknown) => void) =>
      subscribe('transcription:multichannelFallback', cb),
    suggestQuestion: (text: string) => ipcRenderer.invoke('live:suggestQuestion', text),
    askCoach: (transcript: string, question: string) =>
      ipcRenderer.invoke('live:askCoach', { transcript, question }),
    liveCue: (transcript: string, repSpeaker: number | null) =>
      ipcRenderer.invoke('live:cue', { transcript, repSpeaker })
  },
  trackers: {
    /** Turn a rep's plain-English request into a candidate tracker (§4.8).
     *  Raw, unsanitized AI output — the caller must run it through
     *  sanitizeGeneratedTrigger before trusting or persisting it. */
    generate: (prompt: string) => ipcRenderer.invoke('trackers:generate', prompt),
    list: () => ipcRenderer.invoke('trackers:list'),
    save: (trackers: unknown) => ipcRenderer.invoke('trackers:save', trackers)
  },
  dealIntelligence: {
    /** M24 §3 — Tier 1 fast micro-analysis: transcript delta + compact call
     *  state (+ optional deal context, §5) in, risk/opportunity/tactical
     *  signals out. See main/deal-tier1.ts. */
    analyzeTier1: (input: {
      transcriptDelta: string
      compactState: string
      dealContext?: string
      triggerReason?: string
    }) => ipcRenderer.invoke('dealIntelligence:analyzeTier1', input),
    /** M24 §4 — Tier 2 strategic analysis: a wider transcript delta +
     *  compact call state + deal context in, a Deal Health Score out. See
     *  main/deal-tier2.ts. */
    analyzeTier2: (input: {
      transcriptDelta: string
      compactState: string
      dealContext?: string
      triggerReason?: string
    }) => ipcRenderer.invoke('dealIntelligence:analyzeTier2', input),
    /** M24 §8 — the feedback loop. recordFeedback fires immediately per
     *  rating (so it accumulates across calls); getFeedbackSummary is read
     *  once at the start of each call to seed that call's adaptive
     *  confidence thresholds. See main/deal-feedback-fs.ts. */
    recordFeedback: (input: {
      type: 'risk' | 'opportunity' | 'tactical'
      subtype: string
      helpful: boolean
    }) => ipcRenderer.invoke('dealIntelligence:recordFeedback', input),
    getFeedbackSummary: () => ipcRenderer.invoke('dealIntelligence:getFeedbackSummary')
  },
  calls: {
    list: () => ipcRenderer.invoke('calls:list'),
    get: (id: string) => ipcRenderer.invoke('calls:get', id),
    save: (input: unknown, selfIntro?: unknown) =>
      ipcRenderer.invoke('calls:save', input, selfIntro),
    delete: (id: string) => ipcRenderer.invoke('calls:delete', id),
    addAttachment: (callId: string, file: { name: string; ext: string; data: ArrayBuffer }) =>
      ipcRenderer.invoke('calls:addAttachment', callId, file),
    removeAttachment: (callId: string, attachmentId: string) =>
      ipcRenderer.invoke('calls:removeAttachment', callId, attachmentId),
    summarizeCall: (callId: string) => ipcRenderer.invoke('summary:call', callId),
    summarizeAttachment: (callId: string, attachmentId: string) =>
      ipcRenderer.invoke('summary:attachment', callId, attachmentId),
    coachCall: (callId: string) => ipcRenderer.invoke('coach:call', callId),
    extractCommitments: (callId: string) => ipcRenderer.invoke('commitments:extract', callId),
    /** M24 §8 — persist the Radar Report source data onto an already-saved
     *  call. No AI call; the renderer already has the full history. */
    saveDealIntelligence: (callId: string, record: unknown) =>
      ipcRenderer.invoke('dealIntelligence:saveRecord', callId, record),
    mineObjectionsTest: (callId: string) => ipcRenderer.invoke('objections:mineTest', callId),
    enqueueObjections: (callId: string, candidates: unknown) =>
      ipcRenderer.invoke('objections:enqueue', callId, candidates),
    objectionScanEstimate: () => ipcRenderer.invoke('objections:scanEstimate'),
    scanPastCallsForObjections: () => ipcRenderer.invoke('objections:scanPastCalls'),
    generateTitle: (callId: string) => ipcRenderer.invoke('calls:generateTitle', callId),
    postCallBrief: (callId: string) => ipcRenderer.invoke('calls:postCallBrief', callId),
    setContact: (callId: string, contactId: string | null) =>
      ipcRenderer.invoke('calls:setContact', callId, contactId),
    addBookmark: (callId: string, atMs: number, text: string) =>
      ipcRenderer.invoke('calls:addBookmark', callId, atMs, text),
    removeBookmark: (callId: string, bookmarkId: string) =>
      ipcRenderer.invoke('calls:removeBookmark', callId, bookmarkId),
    exportCoachingPdf: (callId: string) => ipcRenderer.invoke('coach:exportPdf', callId),
    setSpeakerName: (
      callId: string,
      key: string,
      name: string | null,
      opts?: { rememberAsContactId?: string }
    ) => ipcRenderer.invoke('calls:setSpeakerName', callId, key, name, opts)
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
  alerts: {
    channels: {
      list: () => ipcRenderer.invoke('alerts:channels:list'),
      startTelegramVerify: (label?: string) =>
        ipcRenderer.invoke('alerts:channels:startTelegramVerify', label),
      startEmailVerify: (address: string) =>
        ipcRenderer.invoke('alerts:channels:startEmailVerify', address),
      confirmEmailCode: (channelId: string, code: string) =>
        ipcRenderer.invoke('alerts:channels:confirmEmailCode', channelId, code),
      delete: (channelId: string) => ipcRenderer.invoke('alerts:channels:delete', channelId),
      whatsappStatus: () => ipcRenderer.invoke('alerts:channels:whatsappStatus'),
      testSend: (channelId: string) => ipcRenderer.invoke('alerts:channels:testSend', channelId)
    },
    rules: {
      list: () => ipcRenderer.invoke('alerts:rules:list'),
      create: (input: unknown) => ipcRenderer.invoke('alerts:rules:create', input),
      update: (ruleId: string, patch: unknown) =>
        ipcRenderer.invoke('alerts:rules:update', ruleId, patch),
      delete: (ruleId: string) => ipcRenderer.invoke('alerts:rules:delete', ruleId)
    },
    settings: {
      get: () => ipcRenderer.invoke('alerts:settings:get'),
      update: (patch: unknown) => ipcRenderer.invoke('alerts:settings:update', patch)
    },
    deliveries: {
      recent: (limit?: number) => ipcRenderer.invoke('alerts:deliveries:recent', limit)
    }
  },
  prepBrief: {
    getForEvent: (input: unknown) => ipcRenderer.invoke('prepBrief:getForEvent', input),
    regenerate: (input: unknown) => ipcRenderer.invoke('prepBrief:regenerate', input),
    onOpenRequested: (cb: (eventId: string) => void) =>
      subscribe<string>('prepBrief:openRequested', cb)
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
    openScreenSettings: () => ipcRenderer.invoke('loopback:openScreenSettings'),
    openWindowsSoundSettings: () => ipcRenderer.invoke('loopback:openWindowsSoundSettings')
  },
  consent: {
    // Synchronous, like arm/disarm: this runs inside the click that opens
    // getDisplayMedia, and an async hop would spend the user activation.
    persist: (sessionId: number, consent: unknown): boolean =>
      ipcRenderer.sendSync('consent:persist', { sessionId, consent }) === true,
    clear: (): void => {
      ipcRenderer.sendSync('consent:clear')
    }
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
    // Kept as inline literal unions (not imported from index.d.ts, which is
    // ambient-only and declares window.api's shape, not this module's) —
    // must stay in lockstep with AiKeyName/AiProviderId there and with
    // AIProviderId/AiKeyName in src/main/ai/types.ts + ai-keys.ts (M20 widened
    // both from the original anthropic/openai-only pair).
    save: (
      name:
        | 'DEEPGRAM_API_KEY'
        | 'ANTHROPIC_API_KEY'
        | 'OPENAI_API_KEY'
        | 'GROQ_API_KEY'
        | 'OPENROUTER_API_KEY'
        | 'GOOGLE_AI_API_KEY'
        | 'NVIDIA_API_KEY'
        | 'CEREBRAS_API_KEY'
        | 'MISTRAL_API_KEY',
      value: string
    ) => ipcRenderer.invoke('aiKeys:save', name, value),
    clear: (
      name:
        | 'DEEPGRAM_API_KEY'
        | 'ANTHROPIC_API_KEY'
        | 'OPENAI_API_KEY'
        | 'GROQ_API_KEY'
        | 'OPENROUTER_API_KEY'
        | 'GOOGLE_AI_API_KEY'
        | 'NVIDIA_API_KEY'
        | 'CEREBRAS_API_KEY'
        | 'MISTRAL_API_KEY'
    ) => ipcRenderer.invoke('aiKeys:clear', name),
    validate: (
      providerId:
        | 'anthropic'
        | 'openai'
        | 'groq'
        | 'openrouter'
        | 'google'
        | 'nvidia'
        | 'cerebras'
        | 'mistral',
      value: string
    ) => ipcRenderer.invoke('aiKeys:validate', providerId, value)
  },
  aiCatalog: {
    // Bundled catalog - instant, no network, used for the picker's first paint.
    list: () => ipcRenderer.invoke('aiCatalog:list'),
    // Cross-checked against each configured provider's live /models endpoint.
    resolve: (forceRefresh?: boolean) =>
      ipcRenderer.invoke('aiCatalog:resolve', forceRefresh === true),
    // V1 chain-editing scope: picks one primary model, main derives the full
    // fallback chain from the bundled default ordering (see catalog-ipc.ts).
    assignPrimaryModel: (purpose: string, catalogId: string) =>
      ipcRenderer.invoke('settings:assignPrimaryModel', purpose, catalogId),
    // Clears a job back to "Automatic" — main picks the best available model
    // from whatever the user has keys for, same resolution completeWithFallback()
    // already uses when nothing's explicitly assigned.
    resetToAutomatic: (purpose: string) => ipcRenderer.invoke('settings:resetToAutomatic', purpose)
  },
  aiFallback: {
    recentEvents: () => ipcRenderer.invoke('aiFallback:recentEvents')
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
    isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getLogsPath: () => ipcRenderer.invoke('app:getLogsPath'),
    openLogsFolder: () => ipcRenderer.invoke('app:openLogsFolder'),
    logRendererError: (scope: string, message: string) =>
      ipcRenderer.invoke('app:logRendererError', scope, message)
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
      subscribe('detection:startCapture', cb),
    getKnownApps: () =>
      ipcRenderer.invoke('detection:getKnownApps') as Promise<
        { appId: string; displayName: string }[]
      >,
    openMainWindow: () => ipcRenderer.invoke('detection:openMainWindow'),
    requestStopCapture: () => ipcRenderer.invoke('detection:requestStopCapture'),
    requestTogglePause: () => ipcRenderer.invoke('detection:requestTogglePause'),
    onRequestStopCapture: (cb: () => void) => subscribe('detection:requestStopCapture', cb),
    onRequestTogglePause: (cb: () => void) => subscribe('detection:requestTogglePause', cb)
  },
  updater: {
    status: () => ipcRenderer.invoke('updater:status'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    /** Quits and installs — only succeeds from a 'downloaded' state; main
     *  re-verifies this itself rather than trusting the renderer's call. */
    install: () => ipcRenderer.invoke('updater:install')
  }
}

// A MessagePort cannot cross contextBridge — it is a transferable, not a
// clonable value — so the audio port (§1.4) is handed to the page the way
// Electron documents: re-post it into the main world with window.postMessage.
// The page then transfers it on to the audio worker, which streams PCM straight
// to the main process without ever waking the renderer's main thread.
//
// Targeted at the page's own origin rather than '*': window.postMessage
// delivers to any listener within the SAME document regardless of
// targetOrigin (that part of the exposure is inherent to re-posting a port
// into the main world at all, and is accepted because this window only ever
// loads the app's own bundle) — but a non-'*' target origin at least means
// the port is never handed to a different origin's content were one ever
// embedded here (an iframe, a future webview), which '*' would not prevent.
// The port carries no authority by itself either way — main accepts audio on
// it only while the window that requested it owns the live session.
export const AUDIO_PORT_MESSAGE = 'callrise:audio-port'
ipcRenderer.on('audio-port:granted', (event: IpcRendererEvent) => {
  const port = event.ports[0]
  if (!port) return
  window.postMessage({ type: AUDIO_PORT_MESSAGE }, window.location.origin, [port])
})

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
