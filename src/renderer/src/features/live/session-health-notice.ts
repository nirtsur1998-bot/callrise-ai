import type { TranscriptionHealthEvent } from '../../../../preload/index.d'

/**
 * Session health (M18 §1) is fully computed and streamed to the renderer
 * every second, but nothing ever showed it — a rep had no way to tell
 * "briefly lagging" from "the socket died and is rebuilding" apart from the
 * per-cue latency number quietly climbing. Meant to fold into the SAME small
 * indicator LiveView already renders rather than a new element: a real
 * problem (shed/reset/socket or capture dead) overrides the plain latency
 * reading with a short label, so the common healthy case looks exactly as it
 * always has.
 *
 * A separate module (not inline in LiveView.tsx) on purpose: LiveView pulls
 * in `@renderer/lib/platform`, which reads `window` at import time, so this
 * pure function couldn't be unit-tested at all sitting inside that file.
 */
export function sessionHealthNotice(
  health: TranscriptionHealthEvent | null
): { label: string; title: string } | null {
  if (!health) return null
  if (health.liveness === 'capture-dead') {
    return { label: 'No audio', title: 'No audio callback for 10s — reconnecting the mic.' }
  }
  if (health.liveness === 'socket-dead') {
    return { label: 'Reconnecting…', title: 'The connection went quiet and is being rebuilt.' }
  }
  if (health.tier === 'reset') {
    return { label: 'Resyncing…', title: 'Lag grew too large — jumping back to the live edge.' }
  }
  if (health.tier === 'shed') {
    return { label: 'Catching up…', title: `Lag: ${health.lagSec.toFixed(1)}s and recovering.` }
  }
  return null
}
