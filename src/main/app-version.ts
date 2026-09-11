import { app } from 'electron'

/**
 * M39 — the running build's version, for `Call.appVersion`.
 *
 * TRY-WRAPPED, and the reason is where it is read. One of its two callers is
 * interrupted-call recovery, and `live:recoverCall` wraps that in a try/catch
 * that returns `{ ok: false }`. So anything that threw here would not surface as
 * an error — it would quietly fail to rescue a 40-minute conversation the rep
 * had just asked us to save, in exchange for a metadata string.
 *
 * `app.getVersion()` does not throw in a real build. It was found throwing
 * anyway, the day this field was added: three test files mock `electron` as
 * `{ app: { getPath } }`, and seven recovery tests went red with
 * `app.getVersion is not a function`. They failed loudly because the tests call
 * `recoverCall` directly; the production path behind the IPC handler would have
 * failed silently. An observation must never be able to alter the outcome it is
 * observing — so a version that cannot be read is simply absent.
 */
export function currentAppVersion(): string | undefined {
  try {
    const v = app.getVersion()
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}
