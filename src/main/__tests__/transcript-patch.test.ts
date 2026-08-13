// M26 Phase 4.3 — the delta protocol between main's transcript and the
// renderer's mirror.
//
// The bar here is not "patches are produced" but "replaying every patch
// reconstructs exactly what main has". A protocol that is subtly lossy would
// show a transcript that drifts from the one being saved — the two copies
// disagreeing without anyone noticing, which is the failure this whole phase
// exists to remove.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { diffFrom, applyPatch } = await import('../live/transcript-patch')
const { setCallJournalsDirForTests } = await import('../live/call-journal')
const {
  beginCall,
  recordResult,
  recordGap,
  recordRepIdentified,
  setTranscriptListener,
  subscribeTranscript,
  currentTranscript,
  liveCallInfo,
  resetLiveTranscriptForTests
} = await import('../live/live-transcript')

import type { TranscriptPatch } from '../live/transcript-patch'
import type { AccumulatedSegment } from '../live/transcript-accumulator'

let dir: string
let patches: TranscriptPatch[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-test-'))
  setCallJournalsDirForTests(dir)
  patches = []
  setTranscriptListener((p) => patches.push(p))
})

afterEach(() => {
  resetLiveTranscriptForTests()
  setCallJournalsDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

type Word = { speaker: number; text: string; channel?: number }

function result(words: Word[], over: Record<string, unknown> = {}): Parameters<
  typeof recordResult
>[0] {
  return {
    transcript: words.map((w) => w.text).join(' '),
    words,
    isFinal: true,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.9,
    multichannel: false,
    ...over
  } as Parameters<typeof recordResult>[0]
}

/** What a renderer that applied every patch in order would be holding. */
function mirror(): AccumulatedSegment[] {
  let out: AccumulatedSegment[] = []
  for (const p of patches) out = applyPatch(out, p)
  return out
}

describe('diffFrom', () => {
  it('finds no difference between identical arrays', () => {
    const a = [{ speaker: 0, text: 'x' }]
    expect(diffFrom(a, a)).toBe(-1)
  })

  it('reports the append point when something was added', () => {
    const a = [{ speaker: 0, text: 'x' }]
    expect(diffFrom(a, [...a, { speaker: 1, text: 'y' }])).toBe(1)
  })

  it('reports the last index when the final turn was rewritten', () => {
    const first = { speaker: 0, text: 'x' }
    const a = [first, { speaker: 1, text: 'y' }]
    expect(diffFrom(a, [first, { speaker: 1, text: 'y z' }])).toBe(1)
  })

  it('reports the first changed index on a back-fill', () => {
    const a = [
      { speaker: 0, text: 'a' },
      { speaker: 1, text: 'b' },
      { speaker: 0, text: 'c' }
    ]
    const b = [a[0], { ...a[1], role: 'other' as const }, a[2]]
    expect(diffFrom(a, b)).toBe(1)
  })

  it('compares by reference, not by value — equal-looking objects still differ', () => {
    // Not a quirk to work around: the accumulator is copy-on-write, so a new
    // object IS a change. Deep equality would silently swallow a real edit
    // that happened to produce the same text.
    expect(diffFrom([{ speaker: 0, text: 'x' }], [{ speaker: 0, text: 'x' }])).toBe(0)
  })
})

describe('applyPatch preserves object identity before the splice point', () => {
  it('keeps untouched rows as the exact same objects', () => {
    // Load-bearing: the transcript row component is memoized on identity, and
    // two consumers track how far they have read by index. A whole-array
    // rebuild would re-render every row of a long call on every utterance.
    const prev = [
      { speaker: 0, text: 'a' },
      { speaker: 1, text: 'b' }
    ]
    const next = applyPatch(prev, { from: 2, segments: [{ speaker: 0, text: 'c' }] })
    expect(next[0]).toBe(prev[0])
    expect(next[1]).toBe(prev[1])
  })
})

describe('the mirror reproduces main exactly', () => {
  it('through appends, merges, gaps and a late rep identification', () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'thanks for joining' }]))
    recordResult(result([{ speaker: 0, text: 'before we start' }])) // merges into the same turn
    recordResult(result([{ speaker: 1, text: 'happy to be here' }]))
    recordGap('[gap: 9s]')
    recordResult(result([{ speaker: 0, text: 'so pricing' }]))
    recordRepIdentified(0, 0)

    expect(JSON.stringify(mirror())).toBe(JSON.stringify(currentTranscript()))
  })

  it('through a reconnect, where speaker numbers stop meaning the same thing', () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'before' }], { speakerEpoch: 0 }))
    recordResult(result([{ speaker: 0, text: 'after' }], { speakerEpoch: 1 }))
    expect(JSON.stringify(mirror())).toBe(JSON.stringify(currentTranscript()))
    expect(mirror()).toHaveLength(2)
  })

  it('through a mono→multichannel restart mid-call', () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'mic only' }]))
    beginCall({ restart: true })
    recordResult(
      result([{ speaker: 0, text: 'now stereo', channel: 0 }], {
        multichannel: true,
        speakerEpoch: 1
      })
    )
    expect(JSON.stringify(mirror())).toBe(JSON.stringify(currentTranscript()))
  })

  it('a new call resets the mirror rather than appending to the old one', () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'first call' }]))
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'second call' }]))

    // Replaying everything from scratch lands on the second call only, because
    // beginCall emits a from:0 reset.
    expect(mirror().map((s) => s.text)).toEqual(['second call'])
    expect(JSON.stringify(mirror())).toBe(JSON.stringify(currentTranscript()))
  })
})

describe('sequence numbers', () => {
  it('start at 0 for a new call and increase by exactly one per change', () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'one' }]))
    recordResult(result([{ speaker: 1, text: 'two' }]))
    expect(patches.map((p) => p.seq)).toEqual([0, 1, 2])
  })

  it('carry the call id, so a stale patch is recognisable', () => {
    beginCall({ restart: false })
    const first = liveCallInfo()!.callId
    recordResult(result([{ speaker: 0, text: 'one' }]))
    beginCall({ restart: false })
    const second = liveCallInfo()!.callId
    expect(first).not.toBe(second)
    expect(patches.filter((p) => p.callId === first)).toHaveLength(2)
    expect(patches.filter((p) => p.callId === second)).toHaveLength(1)
  })

  it('a restart keeps the SAME call id — one call, not two', () => {
    beginCall({ restart: false })
    const id = liveCallInfo()!.callId
    beginCall({ restart: true })
    expect(liveCallInfo()!.callId).toBe(id)
  })
})

describe('publishing never churns the array for nothing', () => {
  // The renderer re-arms its 5-minute "nobody is talking, end the call" timer
  // whenever the segments identity changes. A patch per result — including the
  // ones that add no turn — would make auto-stop unreachable for the whole call.
  it('emits nothing for an interim result', () => {
    beginCall({ restart: false })
    const before = patches.length
    recordResult(result([], { transcript: 'partial', isFinal: false }))
    expect(patches.length).toBe(before)
  })

  it('emits nothing for a final that contains no words', () => {
    beginCall({ restart: false })
    const before = patches.length
    recordResult(result([], { transcript: '   ' }))
    expect(patches.length).toBe(before)
  })

  it('emits nothing for a rep identification that changes no roles', () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'unlabelled' }], { speakerCertain: false }))
    const before = patches.length
    recordRepIdentified(0, 0) // only unlabelled turns exist; none may be back-filled
    expect(patches.length).toBe(before)
  })
})

describe('M26 4.5.0 — subscribeTranscript is an additive tap alongside the renderer relay', () => {
  it('a subscriber sees exactly the same patch stream as the renderer relay', () => {
    const seen: TranscriptPatch[] = []
    const unsubscribe = subscribeTranscript((p) => seen.push(p))
    try {
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'hello there' }]))
      recordGap('[gap: 9s]')
      expect(JSON.stringify(seen)).toBe(JSON.stringify(patches))
    } finally {
      unsubscribe()
    }
  })

  it('two independent subscribers both receive every patch, and unsubscribing one leaves the other unaffected', () => {
    const a: TranscriptPatch[] = []
    const b: TranscriptPatch[] = []
    const unsubA = subscribeTranscript((p) => a.push(p))
    const unsubB = subscribeTranscript((p) => b.push(p))
    try {
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'first' }]))
      unsubA()
      recordResult(result([{ speaker: 1, text: 'second' }]))
      expect(a).toHaveLength(2) // reset + 'first' only
      expect(b).toHaveLength(3) // reset + 'first' + 'second'
    } finally {
      unsubA()
      unsubB()
    }
  })

  it('a throwing subscriber does not stop the renderer relay or other subscribers from getting the patch', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good: TranscriptPatch[] = []
    const unsubBad = subscribeTranscript(() => {
      throw new Error('engine bug')
    })
    const unsubGood = subscribeTranscript((p) => good.push(p))
    try {
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'still works' }]))
      expect(good.length).toBeGreaterThan(0)
      expect(patches.length).toBeGreaterThan(0) // renderer relay unaffected
    } finally {
      unsubBad()
      unsubGood()
      err.mockRestore()
    }
  })

  it('resetLiveTranscriptForTests clears subscribers, same as it clears the renderer relay', () => {
    const seen: TranscriptPatch[] = []
    subscribeTranscript((p) => seen.push(p))
    resetLiveTranscriptForTests()
    setTranscriptListener((p) => patches.push(p)) // afterEach's next beforeEach would normally do this
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'after reset' }]))
    expect(seen).toHaveLength(0)
  })
})

describe('a failed journal costs the safety net, never the transcript', () => {
  it('still accumulates and still publishes when the journal cannot be opened', () => {
    // Before 4.3 this path set the whole call to null, which was survivable
    // only because the renderer held its own copy. Now that this IS the
    // transcript, the same throw would mean no transcript anywhere.
    setCallJournalsDirForTests('\0invalid')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'the call goes on' }]))
      expect(currentTranscript().map((s) => s.text)).toEqual(['the call goes on'])
      expect(JSON.stringify(mirror())).toBe(JSON.stringify(currentTranscript()))
    } finally {
      err.mockRestore()
    }
  })
})
