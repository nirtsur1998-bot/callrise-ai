/** All the visible states the Live view can be in. */
export type LiveStatus =
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
