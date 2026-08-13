/** All the visible states the Live view can be in. */
export type LiveStatus =
  /**
   * M26 4.3 — we have not yet been told whether a call is in progress.
   *
   * The STARTING state, not an edge case. Since 4.3 the transcript lives in the
   * main process, so a freshly mounted Live view genuinely does not know
   * whether the rep is mid-call — it has to ask. Starting at 'idle' would show
   * "Start a call" during a real call, which reads as "my call just died": the
   * worst lie this screen can tell.
   *
   * Nothing leaves this state except main answering. Not a timeout, not a
   * default, not a fallback.
   */
  | 'attaching'
  | 'idle' // not started (or stopped)
  | 'requesting' // asking macOS for microphone permission
  | 'connecting' // mic ok, opening the transcription connection
  | 'listening' // actively transcribing
  | 'paused' // mic held, not sending audio
  | 'reconnecting' // network blip, retrying
  | 'denied' // mic permission denied
  | 'no-device' // no microphone available / unplugged
  | 'no-key' // Deepgram API key missing
  | 'error' // something else went wrong
