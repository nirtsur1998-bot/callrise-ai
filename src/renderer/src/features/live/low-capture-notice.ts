import type { TranscriptionHealthEvent } from '../../../../preload/index.d'

/**
 * BUG-176 — say it DURING the call when almost nothing is being captured.
 *
 * The founder ran a 5m42s call that produced one transcript segment and learned
 * about it only afterwards: *"the call ran, the timer counted, the app showed it
 * recording."* Same class as BUG-172 — a promise made at the start of a call
 * that the app silently fails to keep — and worth surfacing before the
 * mechanism is understood, because the harm is in the silence.
 *
 * BUG-179 — THE FIRST VERSION OF THIS RULE MEASURED THE WRONG THING, and it was
 * caught by running it over the real corpus rather than over fixtures. It
 * counted SEGMENTS per minute, on a measured 7.9-vs-0.7 gap. That gap is real
 * and it is CONFOUNDED: a mono call produces one long blob instead of
 * per-channel turns, so among calls with a perfectly healthy word rate, mono
 * still runs 0.2 segments/min against 10.0. The rule would therefore have told
 * a rep that a call carrying a complete 910-word transcript 'is not being
 * captured properly'. Segments per minute measures SEGMENTATION. The harm is
 * lost words, so the rule counts words.
 *
 * THE THRESHOLD, chosen from the shape of the distribution rather than from a
 * gap between two groups I happened to compare. Across 132 judgeable calls:
 *
 *     exactly 0 wpm   8 calls
 *     0-5 wpm         8 calls      <- with the above, the failure population
 *     5-15 wpm        3 calls      <- the sparse floor between
 *     15-30 wpm       8
 *     30+ wpm        105           <- a continuum, no gap, do not cut into it
 *
 * So 5 wpm sits in the sparse floor under a spike at zero, not inside a
 * continuum. A call below it has captured essentially nothing.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH: a call that records only the rep's
 * side runs around 40 wpm — half a conversation, not a lost one — and is left
 * to the marker on the call detail and to BUG-172's not-ready banner. Widening
 * this rule to reach it would put it inside the continuum, where a genuinely
 * quiet call lives, and a warning that is sometimes false stops being read.
 *
 * WHY submittedSec RATHER THAN WALL CLOCK. It is audio actually handed to the
 * socket, so a call that has barely started, or one paused, cannot trip this by
 * existing. And `liveness === 'ok'` separates the innocent explanations:
 * 'silent' means no audio is arriving (nobody is speaking — not ours to
 * report), while the two dead states already have their own notices.
 */

/** Words per minute of submitted audio, below which we say something. */
export const LOW_CAPTURE_WORDS_PER_MIN = 5

/** Don't judge before this much audio has actually been processed. */
export const LOW_CAPTURE_MIN_SUBMITTED_SEC = 180

export function lowCaptureNotice(input: {
  health: TranscriptionHealthEvent | null
  segments: ReadonlyArray<{ text?: string; kind?: string }>
}): { label: string; title: string } | null {
  const { health, segments } = input
  if (!health) return null
  // Anything other than 'ok' is either not our failure or already reported.
  if (health.liveness !== 'ok') return null
  const submittedSec = health.submittedSec
  if (!Number.isFinite(submittedSec) || submittedSec < LOW_CAPTURE_MIN_SUBMITTED_SEC) return null
  const words = segments.reduce(
    (n, s) =>
      s.kind === 'gap'
        ? n
        : n + String(s.text ?? '')
            .trim()
            .split(/\s+/)
            .filter(Boolean).length,
    0
  )
  const perMin = words / (submittedSec / 60)
  if (perMin >= LOW_CAPTURE_WORDS_PER_MIN) return null
  const mins = Math.round(submittedSec / 60)
  return {
    label: 'Barely transcribing',
    title:
      `Only ${words} ${words === 1 ? 'word has' : 'words have'} been transcribed in ${mins} ` +
      `minutes of audio. If people are talking, this call is not being captured — stopping and ` +
      `starting it again usually fixes it.`
  }
}
