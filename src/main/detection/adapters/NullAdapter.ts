import type { DetectionSignal } from '../types'
import type { ICallDetectorAdapter } from './ICallDetectorAdapter'

/**
 * No-op adapter for unsupported platforms and for tests. `isSupported()`
 * returns `true` (unlike a real "unsupported platform" case) precisely so
 * tests can drive it directly via `emit()` without touching any OS API -
 * this is the adapter every synthetic-signal-trace test in Phase 1 uses.
 */
export class NullAdapter implements ICallDetectorAdapter {
  private listeners = new Set<(signal: DetectionSignal) => void>()
  private started = false

  start(): void {
    this.started = true
  }

  stop(): void {
    this.started = false
  }

  isSupported(): boolean {
    return true
  }

  onSignal(callback: (signal: DetectionSignal) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  /** Test-only: push a synthetic signal as if an adapter had observed it. */
  emit(signal: DetectionSignal): void {
    if (!this.started) return
    for (const listener of this.listeners) listener(signal)
  }
}
