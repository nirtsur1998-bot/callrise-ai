// Microphone hot-plug policy (§5.2).
//
// The failure this exists to prevent is a TRUST failure, not a crash:
// "I unplugged my headset and it kept recording the laptop mic."
//
// It happens because `deviceId: "default"` does not mean "follow the system
// default". Chromium resolves it once, at acquisition, and pins it
// (crbug 40199570) — so when the headset goes away the track does not end, it
// quietly continues on whatever the OS moved to. The rep believes they are
// recording a headset in a quiet room; they are recording a laptop mic in an
// open-plan office, and nothing on screen says so.
//
// Three things make `devicechange` hard to act on directly, and all three are
// handled here rather than at the call site:
//
//   It fires spuriously. Electron emits it on first device open, before
//   anything has actually changed, so a naive handler reacquires the mic
//   immediately after starting the call it was meant to protect.
//
//   It fires in bursts. Plugging in one USB headset can produce several
//   events as its input and output endpoints appear, so acting on the first
//   means acting on a half-enumerated device list.
//
//   It says nothing about WHAT changed. The event carries no payload, so the
//   only honest signal is a diff of the enumerated list against the last one
//   we settled on.

export interface AudioDevice {
  deviceId: string
  label: string
}

export type DeviceChange =
  /** The device we were actually recording from is gone. The important one. */
  | { kind: 'selected-gone'; deviceId: string; devices: AudioDevice[] }
  /** Devices appeared or disappeared, but not the one in use. */
  | { kind: 'list-changed'; added: AudioDevice[]; removed: AudioDevice[]; devices: AudioDevice[] }

export const DEVICE_WATCH_TUNING = {
  /** A burst of events from one physical plug settles inside this. */
  debounceMs: 400,
  /** Electron fires `devicechange` on first open, before anything changed —
   *  acting on it would reacquire the mic seconds after starting the call. */
  startupGraceMs: 2_000
} as const

function byId(devices: AudioDevice[]): Map<string, AudioDevice> {
  return new Map(devices.map((d) => [d.deviceId, d]))
}

export class DeviceWatcher {
  private readonly debounceMs: number
  private readonly graceMs: number
  private startedAtMs: number | null = null
  /** The list we last reported on — the baseline every diff is taken against. */
  private settled: AudioDevice[] = []
  /** Latest snapshot seen since the last settle, and when it arrived. */
  private pending: { devices: AudioDevice[]; atMs: number } | null = null

  constructor(
    debounceMs: number = DEVICE_WATCH_TUNING.debounceMs,
    graceMs: number = DEVICE_WATCH_TUNING.startupGraceMs
  ) {
    this.debounceMs = debounceMs
    this.graceMs = graceMs
  }

  /** Begin watching, with the device list as it stood when capture started. */
  start(atMs: number, devices: AudioDevice[]): void {
    this.startedAtMs = atMs
    this.settled = [...devices]
    this.pending = null
  }

  stop(): void {
    this.startedAtMs = null
    this.pending = null
    this.settled = []
  }

  /** A `devicechange` fired and the list was re-enumerated. Records it; the
   *  decision happens in `settle`, once the burst has finished. */
  observe(atMs: number, devices: AudioDevice[]): void {
    if (this.startedAtMs === null) return
    this.pending = { devices: [...devices], atMs }
  }

  /**
   * Call on a short interval. Returns a change once the burst has settled and
   * the startup grace has passed, or null when there is nothing to report.
   *
   * `selectedDeviceId` is the device capture is actually running on. Pass the
   * RESOLVED id, not `"default"` — the whole point is that `"default"` was
   * already resolved to something concrete at acquisition, and that concrete
   * thing is what can disappear.
   */
  settle(atMs: number, selectedDeviceId: string | null): DeviceChange | null {
    if (this.startedAtMs === null || this.pending === null) return null
    if (atMs - this.startedAtMs < this.graceMs) {
      // Still inside the grace window. Drop the snapshot rather than queueing
      // it: whatever it showed is the state we started in, not a change.
      this.pending = null
      return null
    }
    if (atMs - this.pending.atMs < this.debounceMs) return null

    const devices = this.pending.devices
    this.pending = null

    const before = byId(this.settled)
    const after = byId(devices)
    const added = devices.filter((d) => !before.has(d.deviceId))
    const removed = this.settled.filter((d) => !after.has(d.deviceId))
    this.settled = [...devices]

    // Checked first and reported on its own, because it is the only change
    // that means the recording is no longer what the rep thinks it is.
    if (selectedDeviceId !== null && before.has(selectedDeviceId) && !after.has(selectedDeviceId)) {
      return { kind: 'selected-gone', deviceId: selectedDeviceId, devices }
    }
    if (added.length === 0 && removed.length === 0) return null
    return { kind: 'list-changed', added, removed, devices }
  }
}

/**
 * Idempotent reacquisition, behind a generation counter.
 *
 * Device events arrive in bursts and reacquisition is asynchronous, so two can
 * legitimately be in flight at once — and two overlapping `getUserMedia` calls
 * produce two live tracks feeding the same graph, which is doubled audio: every
 * word transcribed twice, and a talk ratio that says the rep spoke for 200% of
 * the call.
 *
 * Each attempt takes a generation; only the newest may install its result.
 */
export class AcquisitionGeneration {
  private current = 0

  /** Start an attempt. Keep the returned token to check with `isCurrent`. */
  next(): number {
    return ++this.current
  }

  /** Whether this attempt is still the newest, and may install its stream. */
  isCurrent(token: number): boolean {
    return token === this.current
  }

  /** Invalidate everything in flight — used when capture stops entirely. */
  invalidate(): void {
    this.current++
  }
}
