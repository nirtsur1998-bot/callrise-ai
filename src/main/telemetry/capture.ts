// M29 A1.2 — turning crashes and errors into telemetry events.
//
// WHAT AN ERROR EVENT CARRIES, AND WHAT IT DOESN'T.
//   carries: errorClass (constructor name), code (short string, if any),
//            scope (where it was caught), the stack FRAMES (scrubbed, capped)
//   drops:   the error MESSAGE. Messages routinely embed content — "could not
//            find contact John Smith", "summary failed for call 'Acme renewal'",
//            a provider echoing the prompt back. The class + frames locate the
//            bug; the message is where the user's data would leak.
//
// `record()` is a no-op until consent wires it up (A1.3), so registering
// these handlers changes nothing for a user who hasn't opted in.

import { stackFrames } from './events'
import { record, type PropValue } from './index'

// Frame extraction lives in events.ts now, so that buildEvent() applies it to
// ANY 'stack' prop — not only the ones this file builds. Re-exported for the
// existing callers and tests.
export { stackFrames }

/** Constructor name for Errors; a short type label for anything else. */
export function errorClassOf(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor?.name || 'Error'
  if (err === null) return 'null'
  if (typeof err === 'object') return 'object'
  if (typeof err === 'string') {
    // A renderer forwards `stack || message` as a string; its first line is
    // `TypeError: …` — keep the class, never the message.
    const m = /^\s*([A-Z][A-Za-z0-9_]{0,40}(?:Error|Exception))\b/.exec(err)
    return m ? m[1] : 'string'
  }
  return typeof err
}

/** A `.code` is kept only when it is a short identifier (ENOENT, ERR_UPDATER_…), never prose. */
export function errorCodeOf(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  return undefined
}

/** Build the props for an error event. Pure; the scrubber runs inside record(). */
export function errorEventProps(scope: string, err: unknown): Record<string, PropValue> {
  const props: Record<string, PropValue> = {
    scope,
    errorClass: errorClassOf(err)
  }
  const code = errorCodeOf(err)
  if (code) props.code = code
  const frames = stackFrames(err instanceof Error ? err.stack : typeof err === 'string' ? err : '')
  if (frames) props.stack = frames
  return props
}

/** Normalise a free-form scope into an event-name segment: `renderer:live/call` → `renderer.live-call`. */
function nameSegment(scope: string): string {
  const cleaned = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned || 'unknown'
}

/**
 * An error that was caught (or uncaught) somewhere. `scope` is where — e.g.
 * `main.uncaughtException`, `renderer.window.onerror`, `updater.check`.
 * Never throws; never blocks.
 */
export function captureError(scope: string, err: unknown): void {
  try {
    record('error', `error.${nameSegment(scope)}`, errorEventProps(scope, err))
  } catch {
    /* telemetry must never break the thing it is describing */
  }
}

/** Electron's `render-process-gone`: the window's renderer died. Counts as a crash. */
export function captureRendererGone(details: { reason?: unknown; exitCode?: unknown }): void {
  try {
    const props: Record<string, PropValue> = {
      reason: typeof details.reason === 'string' ? details.reason : 'unknown'
    }
    if (typeof details.exitCode === 'number') props.exitCode = details.exitCode
    record('crash', 'crash.renderer', props)
  } catch {
    /* see above */
  }
}

/** Electron's `child-process-gone`: GPU, utility, or plugin process died. */
export function captureChildGone(details: {
  type?: unknown
  reason?: unknown
  exitCode?: unknown
}): void {
  try {
    const props: Record<string, PropValue> = {
      processType: typeof details.type === 'string' ? details.type : 'unknown',
      reason: typeof details.reason === 'string' ? details.reason : 'unknown'
    }
    if (typeof details.exitCode === 'number') props.exitCode = details.exitCode
    record('crash', 'crash.child', props)
  } catch {
    /* see above */
  }
}
