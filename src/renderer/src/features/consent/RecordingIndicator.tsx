// A persistent, honest "is recording on?" signal for the live screen. It says
// "your mic" until the other party's audio is ACTUALLY streaming, and only then
// shows "you + the other party" — so the label never over-claims what's being
// captured (e.g. during the permission prompt, or if buyer capture failed).

interface RecordingIndicatorProps {
  /** Mic capture is actively running (session live, not paused). */
  recording: boolean
  /** Session is paused (mic held, nothing captured). */
  paused?: boolean
  /** Consent to record the other party has been recorded for this call. */
  otherPartyConsented: boolean
  /**
   * Whether the other party's audio is ACTUALLY streaming right now (not merely
   * consented). Only then does the "you + the other party" label appear.
   */
  otherPartyCaptureLive?: boolean
}

export function RecordingIndicator({
  recording,
  paused = false,
  otherPartyConsented,
  otherPartyCaptureLive = false
}: RecordingIndicatorProps): React.JSX.Element {
  if (paused) {
    return (
      <div className="inline-flex items-center gap-2 text-[13px] font-medium text-amber-300">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        Paused — not recording
      </div>
    )
  }

  if (!recording) {
    return (
      <div className="inline-flex items-center gap-2 text-[13px] text-faint">
        <span className="h-2.5 w-2.5 rounded-full border border-faint" />
        Not recording
      </div>
    )
  }

  // Recording. In M11 capturingBoth is always false, so the label says "your mic".
  const capturingBoth = otherPartyCaptureLive
  const label = capturingBoth ? 'Recording — you + the other party' : 'Recording — your mic'

  return (
    <div className="inline-flex items-center gap-2.5">
      <div className="inline-flex items-center gap-2 rounded-full bg-rose-500/15 px-2.5 py-1 ring-1 ring-inset ring-rose-500/30">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </span>
        <span className="text-[13px] font-semibold text-rose-200">{label}</span>
      </div>

      {/* Consent is recorded, but buyer audio isn't streaming this instant
          (e.g. during the permission prompt, or after it stopped). */}
      {otherPartyConsented && !capturingBoth && (
        <span className="text-[11px] text-faint">consent recorded</span>
      )}
      {capturingBoth && (
        <span className="text-[11px] font-medium text-emerald-300">with consent</span>
      )}
    </div>
  )
}
