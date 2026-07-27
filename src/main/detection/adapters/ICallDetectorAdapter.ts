import type { DetectionSignal } from '../types'

/**
 * Platform-agnostic contract every adapter (Mac/Windows/Null) must satisfy.
 * Adapters only ever emit raw `DetectionSignal`s with `weight: 0` - fusion.ts
 * assigns the real weight. Adapters must never filter, debounce, or score;
 * that's the FSM/fusion's job, kept out of platform code so it can be
 * unit-tested without any OS API.
 */
export interface ICallDetectorAdapter {
  /** Start observing. Safe to call once; a second call before `stop()` is a no-op. */
  start(): void
  /** Stop observing and release any OS resources (listeners, polling timers). */
  stop(): void
  /** Subscribe to raw signals. Returns an unsubscribe function. */
  onSignal(callback: (signal: DetectionSignal) => void): () => void
  /** Whether this adapter can actually run on the current platform/OS version. */
  isSupported(): boolean
}
