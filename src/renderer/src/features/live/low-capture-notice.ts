import type { TranscriptionHealthEvent } from '../../../../preload/index.d'

/**
 * BUG-176 — say it DURING the call when almost nothing is being captured.
 *
 * The founder ran a 5m42s call on 2026-09-02 that produced ONE transcript
 * segment. Their words: *"The call ran, the timer counted, the app showed it
 * recording, and I had no reason to think anything was wrong until I opened it
 * afterwards."* That is the same class as BUG-172 — a promise made at the start
 * of a call that the app silently fails to keep — and it is worth surfacing
 * before the mechanism is understood, because the harm is in the silence, not
 * in the cause.
 *
 * MEASURED THRESHOLDS, not chosen ones. Across the founder's saved calls of two
 * minutes or more:
 *
 *   healthy calls    median 7.9 segments per minute
 *   affected calls   median 0.7 segments per minute   (11x apart)
 *
 * The trigger sits at 1.0, inside a gap an order of magnitude wide, so it is
 * not a threshold balanced on a distribution — either side of it is a different
 * kind of call.
 *
 * WHY submittedSec RATHER THAN WALL CLOCK. submittedSec is audio actually
 * handed to the socket, so a call that has barely started, or one paused
 * mid-way, cannot trip this by merely existing. And `liveness === 'ok'` is what
 * separates the two innocent explanations from the real one: 'silent' means no
 * audio is arriving (nobody is speaking — not our problem to report), while
 * 'capture-dead' and 'socket-dead' already have their own notices in
 * sessionHealthNotice and would otherwise be reported twice.
 *
 * DELIBERATELY NOT AN ERROR. A rep on hold with music playing is genuinely
 * having little transcribed, so the wording is an observation about what is
 * being captured rather than a diagnosis of a fault. It is true in every case
 * it fires, which is the only way a warning stays worth reading.
 */

/** Segments per minute of submitted audio, below which we say something. */
export const LOW_CAPTURE_SEGMENTS_PER_MIN = 1.0

/** Don't judge before this much audio has actually been processed. */
export const LOW_CAPTURE_MIN_SUBMITTED_SEC = 180

export function lowCaptureNotice(input: {
  health: TranscriptionHealthEvent | null
  segmentCount: number
}): { label: string; title: string } | null {
  const { health, segmentCount } = input
  if (!health) return null
  // Anything other than 'ok' is either not our failure or already reported.
  if (health.liveness !== 'ok') return null
  const submittedSec = health.submittedSec
  if (!Number.isFinite(submittedSec) || submittedSec < LOW_CAPTURE_MIN_SUBMITTED_SEC) return null
  const perMin = segmentCount / (submittedSec / 60)
  if (perMin >= LOW_CAPTURE_SEGMENTS_PER_MIN) return null
  return {
    label: 'Barely transcribing',
    title:
      `Only ${segmentCount} transcript ${segmentCount === 1 ? 'segment' : 'segments'} in ` +
      `${Math.round(submittedSec / 60)} minutes of audio. If people are talking, this call is ` +
      `not being captured properly — stopping and starting it again usually fixes it.`
  }
}
