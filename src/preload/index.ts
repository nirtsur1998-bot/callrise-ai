import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
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
  // Only ever used for platform-specific CSS/rendering decisions (e.g.
  // DetectionOverlay.tsx's backdrop-filter workaround on win32) — not a
  // general-purpose escape hatch, so keep it to this one primitive.
  platform: process.platform,
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
    /** BUG-111 — tell main the rep paused/resumed capture. Without this, a
     *  pause looks exactly like a dead microphone from main's side and the
     *  liveness watchdog ends the call. Producer-scoped like sendAudio, because
     *  this one DISARMS a watchdog and an orphaned recorder must not be able to
     *  do that to the call that is actually running. */
    setPaused: (paused: boolean, producerId?: number) =>
      ipcRenderer.send('transcription:setPaused', paused, producerId),
    stop: () => ipcRenderer.invoke('transcription:stop'),
    // M26 4.3 — "is there a call in progress, and what is it?". Asked on every
    // mount, because the renderer no longer holds the transcript and cannot
    // answer that from its own state.
    attach: () => ipcRenderer.invoke('transcription:attach'),
    // M26 4.4 — "the view went away", distinct from "the call ended" (that
    // conflation was BUG-046). Fired from LiveView's own unmount, never from
    // the Recorder/session's own lifecycle, which now lives in
    // LiveCallProvider and outlives any one screen.
    detach: () => ipcRenderer.invoke('transcription:detach'),
    onSegments: (cb: (payload: unknown) => void) => subscribe('transcription:segments', cb),
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
    // 1.2.5 hotfix, M27 E1 — callId + includesBuyerContent, same shape as
    // liveCue below, let main check fresh consent before a pass that may
    // include buyer-attributed content ever reaches an AI prompt. Keyed on
    // callId, not sessionId (see main/consent-gate.ts's own doc comment).
    askCoach: (
      transcript: string,
      question: string,
      callId?: string,
      includesBuyerContent?: boolean
    ) =>
      ipcRenderer.invoke('live:askCoach', { transcript, question, callId, includesBuyerContent }),
    // M26 4.5 (BUG-055) / M27 E1 — callId + includesBuyerContent let main
    // check fresh consent before a pass that may include buyer-attributed
    // content ever reaches an AI prompt. See main/live-cue.ts's own doc
    // comment.
    liveCue: (
      transcript: string,
      repSpeaker: number | null,
      callId?: string,
      includesBuyerContent?: boolean
    ) => ipcRenderer.invoke('live:cue', { transcript, repSpeaker, callId, includesBuyerContent })
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
      /** M26 4.5 (BUG-055) / M27 E1 — see main/deal-tier1.ts's own doc
       *  comment. Keyed on callId, not sessionId. */
      callId?: string
      includesBuyerContent?: boolean
    }) => ipcRenderer.invoke('dealIntelligence:analyzeTier1', input),
    /** M24 §4 — Tier 2 strategic analysis: a wider transcript delta +
     *  compact call state + deal context in, a Deal Health Score out. See
     *  main/deal-tier2.ts. */
    analyzeTier2: (input: {
      transcriptDelta: string
      compactState: string
      dealContext?: string
      triggerReason?: string
      callId?: string
      includesBuyerContent?: boolean
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
    setDeal: (callId: string, dealId: string | null) =>
      ipcRenderer.invoke('calls:setDeal', callId, dealId),
    setCallType: (callId: string, callType: string | null) =>
      ipcRenderer.invoke('calls:setCallType', callId, callType),
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
  coach2: {
    getProgress: () => ipcRenderer.invoke('coach2:getProgress'),
    getFocusSkill: () => ipcRenderer.invoke('coach2:getFocusSkill')
  },
  coachChat: {
    send: (callId: string, message: string, mode: string, startFreshPractice?: boolean) =>
      ipcRenderer.invoke('coachChat:send', callId, message, mode, startFreshPractice),
    applySuggestion: (callId: string, suggestion: unknown) =>
      ipcRenderer.invoke('coachChat:applySuggestion', callId, suggestion),
    draftFollowUpEmail: (callId: string) =>
      ipcRenderer.invoke('coachChat:draftFollowUpEmail', callId),
    proposeTask: (callId: string) => ipcRenderer.invoke('coachChat:proposeTask', callId),
    confirmTask: (callId: string, proposal: unknown) =>
      ipcRenderer.invoke('coachChat:confirmTask', callId, proposal),
    regenerateCrmNote: (callId: string) =>
      ipcRenderer.invoke('coachChat:regenerateCrmNote', callId),
    saveCrmNote: (callId: string, note: string) =>
      ipcRenderer.invoke('coachChat:saveCrmNote', callId, note),
    onDelta: (cb: (payload: unknown) => void) => subscribe('coachChat:delta', cb),
    onError: (cb: (payload: unknown) => void) => subscribe('coachChat:error', cb)
  },
  // M28 — the Rise assistant (top-level AI chat section).
  assistant: {
    listConversations: () => ipcRenderer.invoke('assistant:listConversations'),
    getConversation: (id: string) => ipcRenderer.invoke('assistant:getConversation', id),
    createConversation: (scope?: unknown) =>
      ipcRenderer.invoke('assistant:createConversation', scope),
    renameConversation: (id: string, title: string) =>
      ipcRenderer.invoke('assistant:renameConversation', id, title),
    deleteConversation: (id: string) => ipcRenderer.invoke('assistant:deleteConversation', id),
    send: (
      conversationId: string,
      message: string,
      voiceNote?: { mediaId: string; durationMs: number },
      attachmentIds?: string[]
    ) => ipcRenderer.invoke('assistant:send', conversationId, message, voiceNote, attachmentIds),
    addAttachment: (name: string, bytes: ArrayBuffer, conversationId: string) =>
      ipcRenderer.invoke('assistant:addAttachment', name, bytes, conversationId),
    discardAttachment: (id: string) => ipcRenderer.invoke('assistant:discardAttachment', id),
    transcribeVoiceNote: (audio: ArrayBuffer, mimeType: string, durationMs: number) =>
      ipcRenderer.invoke('assistant:transcribeVoiceNote', audio, mimeType, durationMs),
    discardVoiceNote: (mediaId: string) =>
      ipcRenderer.invoke('assistant:discardVoiceNote', mediaId),
    getVoiceNote: (mediaId: string) => ipcRenderer.invoke('assistant:getVoiceNote', mediaId),
    cancel: (conversationId: string) => ipcRenderer.invoke('assistant:cancel', conversationId),
    attach: (conversationId: string) => ipcRenderer.invoke('assistant:attach', conversationId),
    applySuggestion: (conversationId: string, messageId: string, suggestion: unknown) =>
      ipcRenderer.invoke('assistant:applySuggestion', conversationId, messageId, suggestion),
    confirmTask: (conversationId: string, messageId: string, proposalId: string) =>
      ipcRenderer.invoke('assistant:confirmTask', conversationId, messageId, proposalId),
    setSalesBrainExcluded: (conversationId: string, excluded: boolean) =>
      ipcRenderer.invoke('assistant:setSalesBrainExcluded', conversationId, excluded),
    getMemoryEvidence: (memoryId: string) =>
      ipcRenderer.invoke('assistant:getMemoryEvidence', memoryId),
    onDelta: (cb: (payload: unknown) => void) => subscribe('assistant:delta', cb),
    onError: (cb: (payload: unknown) => void) => subscribe('assistant:error', cb),
    onTurnComplete: (cb: (payload: unknown) => void) => subscribe('assistant:turnComplete', cb),
    onPhase: (cb: (payload: unknown) => void) => subscribe('assistant:phase', cb),
    onTrace: (cb: (payload: unknown) => void) => subscribe('assistant:trace', cb)
  },
  crmNoteGenerator: {
    generate: (contactId: string, length: string, opts?: { force?: boolean }) =>
      ipcRenderer.invoke('crmNoteGenerator:generate', contactId, length, opts),
    save: (contactId: string, note: string, jobId?: string) =>
      ipcRenderer.invoke('crmNoteGenerator:save', contactId, note, jobId),
    applyFact: (contactId: string, field: string, text: string, jobId?: string, factId?: string) =>
      ipcRenderer.invoke('crmNoteGenerator:applyFact', contactId, field, text, jobId, factId),
    skipFact: (jobId: string, factId: string) =>
      ipcRenderer.invoke('crmNoteGenerator:skipFact', jobId, factId),
    discardNote: (jobId: string) => ipcRenderer.invoke('crmNoteGenerator:discardNote', jobId)
  },
  contactIntelligence: {
    detectName: (callId: string) => ipcRenderer.invoke('contactIntelligence:detectName', callId)
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (input: unknown) => ipcRenderer.invoke('tasks:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('tasks:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    generateFromCall: (callId: string, opts?: { force?: boolean }) =>
      ipcRenderer.invoke('tasks:generateFromCall', callId, opts),
    markGenerationConsumed: (jobId: string) =>
      ipcRenderer.invoke('tasks:markGenerationConsumed', jobId)
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
    // Read-only batch status for the calendar's prep-brief dots.
    statuses: (inputs: unknown) => ipcRenderer.invoke('prepBrief:statuses', inputs),
    onOpenRequested: (cb: (eventId: string) => void) =>
      subscribe<string>('prepBrief:openRequested', cb)
  },
  salesBrain: {
    /** AUDIT FIX (2026-08-24) — distinguishes OFF / UNAVAILABLE / EMPTY /
     *  READY. memories.list() returns [] for the first three, so callers
     *  could not tell them apart and Rise told users to import call history
     *  when the real fix was to switch Sales Brain on. */
    status: () => ipcRenderer.invoke('salesBrain:status'),
    // M29 A5.3 — one-click consistent snapshot of memory.db while the app runs.
    exportSnapshot: () => ipcRenderer.invoke('salesBrain:exportSnapshot'),
    onboarding: {
      status: () => ipcRenderer.invoke('salesBrain:onboarding:status'),
      submitAnswer: (topicId: string, answer: string) =>
        ipcRenderer.invoke('salesBrain:onboarding:submitAnswer', topicId, answer),
      skipTopic: (topicId: string) =>
        ipcRenderer.invoke('salesBrain:onboarding:skipTopic', topicId),
      skipAll: () => ipcRenderer.invoke('salesBrain:onboarding:skipAll'),
      restart: () => ipcRenderer.invoke('salesBrain:onboarding:restart')
    },
    backfill: {
      start: (opts: {
        includeContacts?: boolean
        includeDeals?: boolean
        includeCalls?: boolean
        /** Forget past attempts and reconsider every call. Normal runs
         *  resume; this is the explicit "learn from everything again". */
        rescanAll?: boolean
      }) => ipcRenderer.invoke('salesBrain:backfill:start', opts)
    },
    memories: {
      list: (opts?: { scope?: string; status?: string }) =>
        ipcRenderer.invoke('salesBrain:memories:list', opts),
      update: (id: string, newStatement: string) =>
        ipcRenderer.invoke('salesBrain:memories:update', id, newStatement),
      setPinned: (id: string, pinned: boolean) =>
        ipcRenderer.invoke('salesBrain:memories:setPinned', id, pinned),
      delete: (id: string) => ipcRenderer.invoke('salesBrain:memories:delete', id),
      forgetEverything: () => ipcRenderer.invoke('salesBrain:memories:forgetEverything'),
      changelog: (scope?: string) => ipcRenderer.invoke('salesBrain:memories:changelog', scope),
      byCall: (callId: string) => ipcRenderer.invoke('salesBrain:memories:byCall', callId)
    },
    calls: {
      setExcluded: (callId: string, excluded: boolean) =>
        ipcRenderer.invoke('salesBrain:calls:setExcluded', callId, excluded),
      getExcluded: (callId: string) => ipcRenderer.invoke('salesBrain:calls:getExcluded', callId)
    },
    onReviewRequested: (cb: (callId: string) => void) =>
      subscribe<string>('salesBrain:reviewRequested', cb)
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
  dealBackfill: {
    state: () => ipcRenderer.invoke('dealBackfill:state'),
    insight: () => ipcRenderer.invoke('dealBackfill:insight'),
    answer: (contactId: string, answer: string) =>
      ipcRenderer.invoke('dealBackfill:answer', contactId, answer),
    clear: (contactId: string) => ipcRenderer.invoke('dealBackfill:clear', contactId),
    // M34 — link a closed deal's own coached calls: one deal, or the whole set.
    linkSuggestions: () => ipcRenderer.invoke('dealBackfill:linkSuggestions'),
    linkCoachedCalls: (dealId: string) =>
      ipcRenderer.invoke('dealBackfill:linkCoachedCalls', dealId),
    linkAllSuggested: () => ipcRenderer.invoke('dealBackfill:linkAllSuggested')
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
    // BUG-169 — the ONE manual retry of a failed push, from the event itself.
    retryPush: (id: string) => ipcRenderer.invoke('events:retryPush', id),
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
    // M27 E1 — keyed on callId, not sessionId (see main/consent-gate.ts's
    // own doc comment for why).
    persist: (callId: string, consent: unknown): boolean =>
      ipcRenderer.sendSync('consent:persist', { callId, consent }) === true,
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
        | 'MISTRAL_API_KEY'
        | 'ZAI_API_KEY'
        | 'HUGGINGFACE_API_KEY'
        | 'CLOUDFLARE_API_KEY'
        | 'CLOUDFLARE_ACCOUNT_ID',
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
        | 'ZAI_API_KEY'
        | 'HUGGINGFACE_API_KEY'
        | 'CLOUDFLARE_API_KEY'
        | 'CLOUDFLARE_ACCOUNT_ID'
    ) => ipcRenderer.invoke('aiKeys:clear', name),
    // BUG-146 — 'deepgram' is NOT a provider id. It names the transcription
    // credential, which has a real check but no PROVIDER_REGISTRY entry (it
    // cannot complete a text request, so it must never reach the default-text-
    // AI-provider picker). Must stay in lockstep with AiValidateTarget in
    // main/ai-keys.ts; a test asserts 'deepgram' is not a provider id, because
    // the day it becomes one this union stops discriminating.
    validate: (
      target:
        | 'anthropic'
        | 'openai'
        | 'groq'
        | 'openrouter'
        | 'google'
        | 'nvidia'
        | 'cerebras'
        | 'mistral'
        | 'zai'
        | 'huggingface'
        | 'cloudflare'
        | 'deepgram',
      value: string
    ) => ipcRenderer.invoke('aiKeys:validate', target, value)
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
    resetToAutomatic: (purpose: string) => ipcRenderer.invoke('settings:resetToAutomatic', purpose),
    // BUG-149 follow-up — which assigned jobs would gain a SECOND PROVIDER if
    // reassigned with the keys held right now. Read-only: the fix is
    // deliberately future-only, so this reports the gap instead of silently
    // closing it. Taking the suggestion calls assignPrimaryModel with the SAME
    // primary, so the user's own pick is never changed for them.
    chainsCouldImprove: () => ipcRenderer.invoke('aiCatalog:chainsCouldImprove')
  },
  aiFallback: {
    recentEvents: () => ipcRenderer.invoke('aiFallback:recentEvents')
  },
  purposeHealth: {
    getAll: () => ipcRenderer.invoke('purposeHealth:getAll')
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
  tier1: {
    // M27 Tier 1 — driver-free noise cancellation for CallRise's OWN audio.
    // Separate from `virtualmic` above on purpose: that one publishes a
    // system-wide capture DEVICE for Zoom/Teams and needs a signed driver;
    // this one delivers denoised PCM to this app over a named pipe and needs
    // nothing installed.
    // attenDb: denoise attenuation limit in dB; omitted = the engine's
    // compiled-in default (the "high" strength). The engine validates and
    // clamps the value itself.
    start: (micName: string, attenDb?: number) =>
      ipcRenderer.invoke('tier1:start', micName, attenDb),
    stop: () => ipcRenderer.invoke('tier1:stop'),
    getStatus: () => ipcRenderer.invoke('tier1:getStatus'),
    // Collects engine logs + status + app state into one zip via a save
    // dialog. The renderer passes a device CLASSIFICATION (BUG-122: never a
    // label) because enumerateDevices() only exists on its side of the bridge.
    exportDiagnostics: (info: {
      devices?: { hasVirtualMic: boolean; inputCount: number; kinds: string[] }
      tier1Enabled?: boolean
      denoiseStrength?: string
    }) => ipcRenderer.invoke('tier1:exportDiagnostics', info),
    onStatus: (cb: (status: unknown) => void) => subscribe('tier1:status', cb),
    // Audio frames. Deliberately NOT routed through `subscribe`'s generic
    // path: this fires ~100x/second and the payload is a transferred
    // ArrayBuffer, so it gets its own minimal listener with no wrapping,
    // logging or JSON work in between. Returns an unsubscribe, same contract
    // as every other listener here, because a live audio callback outliving
    // the call that created it is a leak that keeps a whole AudioContext
    // alive.
    onPcm: (cb: (frame: ArrayBuffer) => void) => {
      const handler = (_e: unknown, frame: ArrayBuffer): void => cb(frame)
      ipcRenderer.on('tier1:pcm', handler)
      return () => ipcRenderer.removeListener('tier1:pcm', handler)
    }
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
    setTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
      ipcRenderer.invoke('app:setTitleBarOverlay', colors),
    getLogsPath: () => ipcRenderer.invoke('app:getLogsPath'),
    openLogsFolder: () => ipcRenderer.invoke('app:openLogsFolder'),
    logRendererError: (scope: string, message: string) =>
      ipcRenderer.invoke('app:logRendererError', scope, message)
  },
  // M29 A5.4 — the support bundle: fallback log, purpose health, job
  // history, versions, device basics, in one folder, ready to email.
  support: {
    createBundle: () => ipcRenderer.invoke('support:createBundle')
  },
  detection: {
    getState: () => ipcRenderer.invoke('detection:getState') as Promise<DetectorState | undefined>,
    /** BUG-155 — the overlay window is click-through by default so it cannot
     *  eat scrolls over the transparent inset around its card; the card asks
     *  for the pointer back while it is underneath it. */
    setOverlayInteractive: (interactive: boolean) =>
      ipcRenderer.invoke('detection:setOverlayInteractive', interactive),
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
  // M29 A1.3 — opt-in diagnostics: consent, the anonymous id, and the real
  // queued payloads (Settings → Privacy → Diagnostics & telemetry).
  telemetry: {
    getState: () => ipcRenderer.invoke('telemetry:getState'),
    setConsent: (value: 'on' | 'off') => ipcRenderer.invoke('telemetry:setConsent', value),
    clearQueue: () => ipcRenderer.invoke('telemetry:clearQueue'),
    clearSent: () => ipcRenderer.invoke('telemetry:clearSent'),
    featureOpened: (feature: string) => ipcRenderer.invoke('telemetry:featureOpened', feature),
    flushNow: () => ipcRenderer.invoke('telemetry:flushNow')
  },
  updater: {
    status: () => ipcRenderer.invoke('updater:status'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    /** Quits and installs — only succeeds from a 'downloaded' state; main
     *  re-verifies this itself rather than trusting the renderer's call. */
    install: () => ipcRenderer.invoke('updater:install')
  },
  // M26 Phase 4.2 — main's own journaled copy of the call in progress, plus
  // the recovery surface for calls that never reached a save.
  live: {
    // `send`, not `invoke` — nothing waits on this, and nothing about it may
    // ever be able to affect a live call.
    repIdentified: (epoch: number, speaker: number) =>
      ipcRenderer.send('live:repIdentified', epoch, speaker),
    listRecoverable: () => ipcRenderer.invoke('live:listRecoverable'),
    recoverCall: (id: string) => ipcRenderer.invoke('live:recoverCall', id),
    discardRecoverable: (id: string) => ipcRenderer.invoke('live:discardRecoverable', id)
  },
  // M26 — read-only + control surface over the job queue. No generic
  // enqueue here on purpose (see jobs/ipc.ts's file header): only a real
  // feature's own IPC handler, running in main, may start a job.
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    get: (id: string) => ipcRenderer.invoke('jobs:get', id),
    cancel: (id: string) => ipcRenderer.invoke('jobs:cancel', id),
    retry: (id: string) => ipcRenderer.invoke('jobs:retry', id),
    resume: (id: string) => ipcRenderer.invoke('jobs:resume', id),
    dismiss: (id: string) => ipcRenderer.invoke('jobs:dismiss', id),
    /** Full current snapshot, pushed at most ~4/sec (see jobs/ipc.ts). */
    onChanged: (cb: (payload: unknown) => void) => subscribe('jobs:changed', cb),
    /** One event per start/completion (never for a merely-queued or
     *  cancelled/interrupted transition — see jobs/activity.ts), already
     *  call-aware-DND-filtered by main: never fires while a live call is
     *  active, delivered as a digest instead once it ends. */
    onNotify: (cb: (payload: unknown) => void) => subscribe('jobs:notify', cb),
    /** Fired when the rep clicks an OS-native job notification — id is the
     *  job to open, or undefined for a digest (open the Activity panel). */
    onOpenRequested: (cb: (jobId: string | undefined) => void) =>
      subscribe('jobs:openRequested', cb),
    // Dev builds only — see the is.dev guard in main/index.ts and
    // jobs/ipc.ts. Present on the bridge either way so the renderer's Job
    // Inspector doesn't need its own separate is-dev branch to call it;
    // main simply never registers the handler outside a dev build, so the
    // invoke rejects instead.
    dev: {
      startFake: (req: unknown) => ipcRenderer.invoke('jobs:dev:startFake', req)
    }
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

// `electron` (@electron-toolkit/preload's `electronAPI`) is DELIBERATELY NOT
// exposed. It is electron-vite scaffold boilerplate, and it hands the renderer
// a raw `ipcRenderer` whose every method takes the channel name as a FREE
// PARAMETER — `invoke`, `send`, `sendSync`, `postMessage`, `on`, `once`,
// `removeAllListeners`. That reaches every `ipcMain.handle` and `ipcMain.on`
// channel in the app (`aiKeys:save`, `settings:update`, `auth:signOut`,
// `salesBrain:memories:forgetEverything`, `consent:persist`, …) completely
// bypassing the curated `api` object below, plus `process.env`, which holds
// the user's AI API keys — defeating this file's own masking policy, where
// `aiKeys:getStatus` deliberately returns only a masked hint.
//
// Its single consumer was `renderer/lib/platform.ts` reading
// `window.electron.process.platform`, for which `api.platform` above is the
// same value. So the whole wide surface existed to serve one string the
// narrow API already provided. Do not re-add it: if something needs a new
// capability, give it a named channel here.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
