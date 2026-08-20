// @vitest-environment happy-dom
//
// M27 Tier 1 — recorder.ts checkpoint. See docs/M27-tier1-recorder-handoff.md.
//
// recorder.ts has never been unit tested before this file: it is deeply
// coupled to real Web Audio APIs happy-dom does not implement. This builds a
// minimal fake graph — enough to prove EDGES connect/disconnect correctly —
// not enough to prove audio quality, which stays a manual/field check.
//
// FAILS OPEN IS THE PROPERTY EVERY TEST HERE IS REALLY CHECKING, same as
// tier1.test.ts's own framing: whatever goes wrong (no Tier 1 API, an unsafe
// mic name, the pipe dropping mid-call), the real microphone keeps recording
// and the transcript keeps flowing. The one property with real stakes is
// "raw mic never disconnected" — every other failure here degrades audio,
// that one loses a recorded call — so it gets a spy-based direct assertion,
// not an inference from behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../pump', () => ({
  // No fast path in this harness (no real Worker/SharedArrayBuffer) — matches
  // how recorder.ts already behaves on any machine without them: the
  // existing try/catch leaves `pump` null and nothing downstream cares.
  startAudioPump: vi.fn(async () => {
    throw new Error('no fast path in tests')
  })
}))

// ---- Minimal fake Web Audio graph -----------------------------------------
// Real enough to prove which edges exist; not a real audio engine.
class FakeAudioNode {
  connections: Array<{ dest: FakeAudioNode; output: number; input: number }> = []
  connect(dest: FakeAudioNode, output = 0, input = 0): FakeAudioNode {
    if (!this.isConnectedTo(dest, output, input)) {
      this.connections.push({ dest, output, input })
    }
    return dest
  }
  disconnect(dest?: FakeAudioNode, output = 0, input = 0): void {
    if (dest === undefined) {
      this.connections = []
      return
    }
    const before = this.connections.length
    this.connections = this.connections.filter(
      (c) => !(c.dest === dest && c.output === output && c.input === input)
    )
    if (this.connections.length === before) {
      throw new Error('InvalidAccessError: the given destination is not connected')
    }
  }
  isConnectedTo(dest: FakeAudioNode, output = 0, input = 0): boolean {
    return this.connections.some((c) => c.dest === dest && c.output === output && c.input === input)
  }
}
class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 }
}
class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 0
  smoothingTimeConstant = 0
}
class FakeChannelMergerNode extends FakeAudioNode {}
class FakeMediaStreamAudioSourceNode extends FakeAudioNode {}
class FakeAudioWorkletNode extends FakeAudioNode {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown, t?: unknown[]) => void }
  constructor(
    _ctx: unknown,
    public name: string,
    _opts?: unknown
  ) {
    super()
    this.port = { onmessage: null, postMessage: vi.fn() }
  }
}

let createdWorkletNodes: FakeAudioWorkletNode[] = []
let createdSources: FakeMediaStreamAudioSourceNode[] = []
let createdGains: FakeGainNode[] = []
let createdMergers: FakeChannelMergerNode[] = []
let addedModuleUrls: string[] = []
let destinationNode: FakeAudioNode

class FakeAudioContext {
  sampleRate = 16000
  destination = destinationNode
  audioWorklet = {
    addModule: vi.fn(async (url: string) => {
      addedModuleUrls.push(url)
    })
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
  createMediaStreamSource(_s: unknown): FakeMediaStreamAudioSourceNode {
    const n = new FakeMediaStreamAudioSourceNode()
    createdSources.push(n)
    return n
  }
  createGain(): FakeGainNode {
    const n = new FakeGainNode()
    createdGains.push(n)
    return n
  }
  createAnalyser(): FakeAnalyserNode {
    return new FakeAnalyserNode()
  }
}

// ---- Fake mic stream --------------------------------------------------
function makeFakeTrack(label: string): {
  label: string
  readyState: string
  stop: ReturnType<typeof vi.fn>
  addEventListener: (type: string, cb: () => void) => void
  removeEventListener: (type: string, cb: () => void) => void
  emit: (type: string) => void
} {
  const listeners = new Map<string, Set<() => void>>()
  return {
    label,
    readyState: 'live',
    stop: vi.fn(),
    addEventListener: (type, cb) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener: (type, cb) => {
      listeners.get(type)?.delete(cb)
    },
    emit: (type) => {
      listeners.get(type)?.forEach((cb) => cb())
    }
  }
}

function makeFakeStream(label: string): { active: boolean; getAudioTracks: () => unknown[]; getTracks: () => unknown[] } & {
  track: ReturnType<typeof makeFakeTrack>
} {
  const track = makeFakeTrack(label)
  return {
    active: true,
    getAudioTracks: () => [track],
    getTracks: () => [track],
    track
  }
}

// ---- Fake window.api.tier1 -------------------------------------------
function makeFakeTier1Api(): {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  onStatus: ReturnType<typeof vi.fn>
  onPcm: ReturnType<typeof vi.fn>
  emitStatus: (s: unknown) => void
} {
  const statusCbs = new Set<(s: unknown) => void>()
  const pcmCbs = new Set<(f: ArrayBuffer) => void>()
  return {
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    getStatus: vi.fn(async () => ({
      engineAvailable: true,
      engineRunning: false,
      connected: false,
      denoisingActive: null,
      enginePath: 'C:\\x\\kern_bridge.exe'
    })),
    onStatus: vi.fn((cb: (s: unknown) => void) => {
      statusCbs.add(cb)
      return () => statusCbs.delete(cb)
    }),
    onPcm: vi.fn((cb: (f: ArrayBuffer) => void) => {
      pcmCbs.add(cb)
      return () => pcmCbs.delete(cb)
    }),
    emitStatus: (s: unknown) => statusCbs.forEach((cb) => cb(s))
  }
}

function activeStatus(): unknown {
  return { engineAvailable: true, engineRunning: true, connected: true, denoisingActive: true, enginePath: 'x' }
}
function passthroughStatus(): unknown {
  return { engineAvailable: true, engineRunning: true, connected: true, denoisingActive: false, enginePath: 'x' }
}
function droppedStatus(): unknown {
  return { engineAvailable: true, engineRunning: true, connected: false, denoisingActive: null, enginePath: 'x' }
}

let fakeTier1Api: ReturnType<typeof makeFakeTier1Api>
let fakeStream: ReturnType<typeof makeFakeStream>

const { startRecorder, resolveTier1MicName } = await import('../recorder')
const { setTier1Enabled } = await import('@renderer/features/settings/prefs')

beforeEach(() => {
  createdWorkletNodes = []
  createdSources = []
  createdGains = []
  createdMergers = []
  addedModuleUrls = []
  destinationNode = new FakeAudioNode()

  // Every test below is about Tier 1 BEHAVIOR once a user has opted in — the
  // opt-in gate itself (default OFF) gets its own describe block further
  // down, which explicitly clears this. Setting it here, once, keeps every
  // other test from having to know this preference exists at all.
  localStorage.clear()
  setTier1Enabled(true)

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal(
    'ChannelMergerNode',
    class extends FakeChannelMergerNode {
      constructor() {
        super()
        createdMergers.push(this)
      }
    }
  )
  vi.stubGlobal(
    'AudioWorkletNode',
    class extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts?: unknown) {
        super(ctx, name, opts)
        createdWorkletNodes.push(this)
      }
    }
  )

  fakeStream = makeFakeStream('Microphone Array (Realtek(R) Audio)')
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream) }
  })

  fakeTier1Api = makeFakeTier1Api()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { tier1: fakeTier1Api }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function pcmProcessorNode(): FakeAudioWorkletNode {
  const n = createdWorkletNodes.find((w) => w.name === 'pcm-processor')
  if (!n) throw new Error('pcm-processor worklet was never created')
  return n
}
function denoisedSourceNode(): FakeAudioWorkletNode | undefined {
  return createdWorkletNodes.find((w) => w.name === 'denoised-source')
}
function mergerNode(): FakeChannelMergerNode {
  const n = createdMergers[0]
  if (!n) throw new Error('ChannelMergerNode was never created')
  return n
}

// ---------------------------------------------------------------------------
describe('resolveTier1MicName', () => {
  it('passes a real device label through unchanged', () => {
    expect(resolveTier1MicName('Microphone Array (Realtek(R) Audio)')).toBe(
      'Microphone Array (Realtek(R) Audio)'
    )
  })

  it('returns null (never empty string) for our own virtual mic', () => {
    // An empty argument does not mean "no preference" to kern_bridge — it
    // falls through to the engine's OWN auto-pick, which is exactly the
    // failure this function exists to keep away from a virtual-only user.
    expect(resolveTier1MicName('CallRise AI Microphone (CallRise AI Audio)')).toBeNull()
  })

  it('returns null for an empty label rather than passing "" through', () => {
    expect(resolveTier1MicName('')).toBeNull()
  })

  // F-08 (renderer half). kern_bridge.cpp's own comment asserts the renderer
  // already does this exclusion before ever calling it — this is that half
  // of the contract actually existing. Without it: a machine whose resolved
  // input device is a competitor's virtual/denoising mic gets Tier 1 telling
  // kern_bridge to capture and re-denoise ALREADY-denoised audio as if it
  // were real hardware — the exact double-processing bug F-08 was named for,
  // observed live with this exact device string.
  it('returns null for a third-party virtual/denoising mic — the observed live case', () => {
    expect(resolveTier1MicName('Krisp Microphone (Krisp Audio)')).toBeNull()
  })

  it('returns null for other known third-party virtual mics, mirroring kern_bridge.cpp\'s vendor list', () => {
    expect(resolveTier1MicName('CABLE Output (VB-Audio Virtual Cable)')).toBeNull()
    expect(resolveTier1MicName('VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)')).toBeNull()
    expect(resolveTier1MicName('NVIDIA Broadcast')).toBeNull()
    expect(resolveTier1MicName('Discord Virtual Microphone')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// THE OPT-IN GATE. Off by default: a first run that silently reroutes
// someone's microphone through a new engine is a support ticket, not a
// nicety. Every other test in this file explicitly opts in via beforeEach —
// this block is the only one that tests the gate itself, on a real engine,
// real mic name, everything else present and correct.
describe('tier1 preference — off by default, opt-in required', () => {
  it('never starts Tier 1 when the preference has never been set', async () => {
    setTier1Enabled(false) // explicit, though clearing localStorage already implies it
    await startRecorder(vi.fn(), vi.fn())

    expect(fakeTier1Api.start).not.toHaveBeenCalled()
    expect(denoisedSourceNode()).toBeUndefined()
  })

  it('starts Tier 1 once the preference is explicitly turned on', async () => {
    setTier1Enabled(true)
    await startRecorder(vi.fn(), vi.fn())

    // Second arg undefined = strength "high": --atten omitted so the
    // engine's compiled-in default stands. The mapping itself is covered in
    // the strength block below.
    expect(fakeTier1Api.start).toHaveBeenCalledWith(
      'Microphone Array (Realtek(R) Audio)',
      undefined
    )
  })

  // Strength → attenDb mapping, read at call start exactly like `enabled`.
  it('passes 12dB for low and 20dB for medium, by name not by guess', async () => {
    const { setDenoiseStrength } = await import('@renderer/features/settings/prefs')
    setTier1Enabled(true)

    setDenoiseStrength('low')
    await startRecorder(vi.fn(), vi.fn())
    expect(fakeTier1Api.start).toHaveBeenLastCalledWith('Microphone Array (Realtek(R) Audio)', 12)
  })

  it('passes 20dB for medium', async () => {
    const { setDenoiseStrength } = await import('@renderer/features/settings/prefs')
    setTier1Enabled(true)
    setDenoiseStrength('medium')
    await startRecorder(vi.fn(), vi.fn())
    expect(fakeTier1Api.start).toHaveBeenLastCalledWith('Microphone Array (Realtek(R) Audio)', 20)
  })

  it('passes undefined (not 100) for high — the engine default must stay the source of truth', async () => {
    const { setDenoiseStrength } = await import('@renderer/features/settings/prefs')
    setTier1Enabled(true)
    setDenoiseStrength('high')
    await startRecorder(vi.fn(), vi.fn())
    expect(fakeTier1Api.start).toHaveBeenLastCalledWith(
      'Microphone Array (Realtek(R) Audio)',
      undefined
    )
  })

  it('reads the preference once at call start, not live mid-call', async () => {
    // Flipping the setting mid-call must not retroactively start or stop an
    // already-running call's engine — that would be a live toggle, which
    // this explicitly is not (see getTier1Enabled's own doc comment).
    setTier1Enabled(true)
    await startRecorder(vi.fn(), vi.fn())
    expect(fakeTier1Api.start).toHaveBeenCalledTimes(1)

    setTier1Enabled(false)
    // No second call, no stop triggered by the preference change alone.
    expect(fakeTier1Api.start).toHaveBeenCalledTimes(1)
    expect(fakeTier1Api.stop).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// PROPERTY 1 — existing path unchanged when Tier 1 is unavailable.
describe('property 1 — existing path unchanged when Tier 1 unavailable', () => {
  it('never creates a denoised-source node or calls tier1Api.start when window.api.tier1 is absent', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    const onChunk = vi.fn()
    await startRecorder(onChunk, vi.fn())

    expect(denoisedSourceNode()).toBeUndefined()
    expect(createdWorkletNodes.map((w) => w.name)).toEqual(['pcm-processor'])
    expect(addedModuleUrls.some((u) => u.includes('denoised'))).toBe(false)

    const micSource = createdSources[0]!
    const merger = mergerNode()
    expect(micSource.isConnectedTo(merger, 0, 0)).toBe(true)
  })

  it('never creates a denoised-source node or calls start when only a virtual mic is available', async () => {
    fakeStream = makeFakeStream('CallRise AI Microphone (CallRise AI Audio)')
    ;(navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(fakeStream)

    await startRecorder(vi.fn(), vi.fn())

    expect(denoisedSourceNode()).toBeUndefined()
    expect(fakeTier1Api.start).not.toHaveBeenCalled()
  })

  it('the raw path recorder returns is byte-identical in shape: mic feeds merger ch0 from the start', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    const rec = await startRecorder(vi.fn(), vi.fn())
    expect(rec.isTier1Active()).toBe(false)
    const micSource = createdSources[0]!
    const merger = mergerNode()
    expect(micSource.isConnectedTo(merger, 0, 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PROPERTY 2 — raw mic never disconnected. THE dangerous property: a mistake
// here costs a recorded call, not degraded audio. Asserted directly on the
// track and on the graph, not inferred from "recording still works."
describe('property 2 — raw mic never disconnected', () => {
  it('never calls track.stop() while Tier 1 toggles on and off through a live call', async () => {
    const rec = await startRecorder(vi.fn(), vi.fn())
    const track = fakeStream.track

    fakeTier1Api.emitStatus(activeStatus())
    expect(rec.isTier1Active()).toBe(true)
    expect(track.stop).not.toHaveBeenCalled()
    expect(track.readyState).toBe('live')

    fakeTier1Api.emitStatus(droppedStatus())
    expect(rec.isTier1Active()).toBe(false)
    expect(track.stop).not.toHaveBeenCalled()
    expect(track.readyState).toBe('live')

    fakeTier1Api.emitStatus(activeStatus())
    expect(track.stop).not.toHaveBeenCalled()
    expect(fakeStream.active).toBe(true)
  })

  it('keeps micSource connected to the analyser (waveform) at all times, even while Tier 1 is active', async () => {
    await startRecorder(vi.fn(), vi.fn())
    const micSource = createdSources[0]!
    // The analyser is the 2nd node micSource connects to in startRecorder
    // (merger is 1st) — find it as whichever connection ISN'T the merger.
    const merger = mergerNode()
    const analyserEdge = micSource.connections.find((c) => c.dest !== merger)
    expect(analyserEdge).toBeDefined()

    fakeTier1Api.emitStatus(activeStatus())

    // RED without the "switch edges, not tracks" design: a naive
    // implementation that called micSource.disconnect() with no arguments to
    // hand off to Tier 1 would also sever the analyser edge here.
    expect(micSource.isConnectedTo(analyserEdge!.dest)).toBe(true)
  })

  it('never calls the ARGUMENT-LESS full disconnect() on micSource while merely switching sources', async () => {
    const rec = await startRecorder(vi.fn(), vi.fn())
    const micSource = createdSources[0]!
    const fullDisconnectSpy = vi.spyOn(micSource, 'disconnect')

    fakeTier1Api.emitStatus(activeStatus())
    fakeTier1Api.emitStatus(droppedStatus())
    fakeTier1Api.emitStatus(activeStatus())

    // Every call must have carried the targeted (dest, output, input) form —
    // a bare call() with zero arguments is the one that would tear out the
    // analyser edge too.
    for (const call of fullDisconnectSpy.mock.calls) {
      expect(call.length).toBeGreaterThan(0)
    }
    rec.stop()
  })
})

// ---------------------------------------------------------------------------
// PROPERTY 3 — pipe killed mid-stream: transcript survives on raw audio.
describe('property 3 — pipe killed mid-stream, transcript survives', () => {
  it('keeps delivering chunks to onChunk before, during the drop, and after', async () => {
    const onChunk = vi.fn()
    await startRecorder(onChunk, vi.fn())
    const chunker = pcmProcessorNode()

    fakeTier1Api.emitStatus(activeStatus())
    chunker.port.onmessage?.({ data: new ArrayBuffer(4) })
    expect(onChunk).toHaveBeenCalledTimes(1)

    // The pipe drops mid-call.
    fakeTier1Api.emitStatus(droppedStatus())
    chunker.port.onmessage?.({ data: new ArrayBuffer(4) })

    // RED without the fallback: onChunk would have stopped receiving new
    // data the moment the pipe died, because nothing would have reconnected
    // the merger's ch0 input to anything.
    expect(onChunk).toHaveBeenCalledTimes(2)
  })

  it('routes the merger back to the raw mic, not the (now-stale) tier1 node, once the pipe drops', async () => {
    await startRecorder(vi.fn(), vi.fn())
    const micSource = createdSources[0]!
    const merger = mergerNode()

    fakeTier1Api.emitStatus(activeStatus())
    const tier1 = denoisedSourceNode()!
    expect(tier1.isConnectedTo(merger, 0, 0)).toBe(true)
    expect(micSource.isConnectedTo(merger, 0, 0)).toBe(false)

    fakeTier1Api.emitStatus(droppedStatus())

    expect(micSource.isConnectedTo(merger, 0, 0)).toBe(true)
    expect(tier1.isConnectedTo(merger, 0, 0)).toBe(false)
  })

  it('never activates on PASSTHROUGH — connected is not enough, denoisingActive:false stays on raw', async () => {
    await startRecorder(vi.fn(), vi.fn())
    const micSource = createdSources[0]!
    const merger = mergerNode()

    fakeTier1Api.emitStatus(passthroughStatus())

    expect(micSource.isConnectedTo(merger, 0, 0)).toBe(true)
    expect(denoisedSourceNode()?.isConnectedTo(merger, 0, 0)).not.toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('teardown', () => {
  it('unsubscribes both tier1 listeners and stops the engine on stop()', async () => {
    const rec = await startRecorder(vi.fn(), vi.fn())
    fakeTier1Api.emitStatus(activeStatus())

    rec.stop()

    expect(fakeTier1Api.stop).toHaveBeenCalledTimes(1)
    // A stale onPcm firing after stop() must not reach a live worklet port —
    // the same "no leaked callback" shape the preload API's own contract
    // requires (see src/preload/index.ts's onPcm doc comment).
    const pcmCallsBefore = pcmProcessorNode().port.postMessage as ReturnType<typeof vi.fn>
    const before = pcmCallsBefore.mock.calls.length
    fakeTier1Api.emitStatus(activeStatus())
    expect(pcmCallsBefore.mock.calls.length).toBe(before)
  })

  it('calling stop() twice does not throw', async () => {
    const rec = await startRecorder(vi.fn(), vi.fn())
    rec.stop()
    expect(() => rec.stop()).not.toThrow()
  })
})
