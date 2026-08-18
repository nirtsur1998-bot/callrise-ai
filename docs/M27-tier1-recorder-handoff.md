# Tier 1 — recorder.ts checkpoint: handoff

**Written 2026-08-18, end of a long session, deliberately stopping before this
edit.** Everything below is committed on `claude/m27-field-hardening`.

This document exists so the next session does not have to reconstruct intent
from code. The interfaces are settled; what remains is one delicate edit and
its verification.

---

## Why this edit was deferred rather than finished

`recorder.ts` is live call capture. Of the four properties below, **"raw mic
never disconnected" is the one where a mistake costs someone a recorded call
rather than a degraded one** — every other failure here degrades audio, that
one loses it.

It is also exactly the shape of property that gets asserted *vacuously*: an
assertion that passes because it cannot fail. That happened once already this
month (a drag test asserting `textContent` contained "Activity", which was
always true because the button's `title` attribute said so — caught only
because a red-check showed 1 of 6 tests failing when all 6 should have).

Thin attention at the tail of a long session is the documented condition for
that error. Hence the stop. **Do not fold this into a larger sweep.**

---

## State of the world

| Piece | Status |
|---|---|
| `kern_bridge.exe` — model resolution, status sidecar | **Done, verified on real binary** (all 3 branches) |
| `src/main/tier1.ts` — pipe client, `denoisingActive` | **Done**, 30 tests, 3 guards red-checked |
| `electron-builder.yml` — `win: extraResources` | **Done**, verified by listing the built artifact |
| `src/preload/index.ts` — `window.api.tier1` | **Done** (`e7822b9`) |
| `tier1-source.ts` — guard, UI state, ring | **Done**, 17 tests, guard red-checked |
| **`recorder.ts` — graph wiring** | **NOT STARTED — this is the task** |
| Worklet asset (`denoised-source.js`) | **NOT STARTED** |
| Merge → 1.3.0, suite, bundle-verify, publish | Blocked on the above |

**The feature currently does nothing for a user.** The preload API exists and
nothing calls it; `tier1.ts` broadcasts `tier1:pcm` to windows where nothing
listens. That is the entire remaining gap.

---

## Interfaces you inherit (do not redesign these)

### `window.api.tier1` — `src/preload/index.ts`

```ts
start(micName: string): Promise<{ ok: boolean; error?: string }>
stop(): Promise<{ ok: boolean }>
getStatus(): Promise<Tier1Status>
onStatus(cb: (s: Tier1Status) => void): () => void   // returns unsubscribe
onPcm(cb: (frame: ArrayBuffer) => void): () => void  // returns unsubscribe
```

`onPcm` bypasses the generic `subscribe` helper on purpose — it fires ~100×/s
with a transferred `ArrayBuffer`, so there is no wrapping or logging in the
path. **Both return an unsubscribe, and both must be called on teardown**: a
live audio callback outliving its call keeps an entire `AudioContext` alive.

### `shouldUseDenoisedSource(status): boolean` — `tier1-source.ts`

The only thing permitted to decide that denoised audio replaces the raw mic.

**Do not re-derive this condition inline in `recorder.ts`.** Requires
`denoisingActive === true`; `null` and `false` both mean no. The reason is not
stylistic: a PASSTHROUGH pipe is a **downgrade**, not a no-op, because raw
`getUserMedia` audio receives Chromium's AEC / NS / AGC and the pipe path
bypasses all three. Choosing the pipe when the model did not load actively
makes the user's call worse.

### `tier1UiState(status, wanted): Tier1UiState` — `tier1-source.ts`

`'unavailable' | 'off' | 'starting' | 'active' | 'model-missing'`.

`'model-missing'` is a **named, user-visible error state**, deliberately not
folded into `'off'` or `'starting'`. A feature that reports healthy and does
nothing is the failure this whole release exists to fix.

### `Tier1Ring` — `tier1-source.ts`

Bridges the pipe's ~100 Hz / 480-sample frames to the graph's 128-sample
render quantum. `push(Float32Array)` / `pull(out)` (always fills, pads with
silence). Drops **oldest** on overflow — an unbounded queue converts a small
timing error into permanently increasing latency the user never recovers from.
`overflowSamples` / `underrunSamples` are counted; surface them, don't swallow.

---

## The graph as it exists today (`recorder.ts:79-130`)

```
micSource ──┬─→ merger ch0 ─→ worklet('pcm-processor') ─→ destination
            └─→ analyser                                  (waveform = rep only)
loopSource ───→ merger ch1        (buyer capture, when consented)
```

`worklet.port.onmessage` → `onChunk(...)` → transcription.
There is also a shared-memory fast path (`AudioPump`) with a `postMessage`
fallback — **leave both alone**, Tier 1 sits upstream of the worklet.

### Suggested shape (not binding)

Substitute only the **source feeding merger ch0**. Keep
`micSource.connect(analyser)` unconditionally so the waveform keeps reflecting
the real microphone. Switch edges, never tracks:

- Tier 1 active → `tier1Node → merger ch0`
- otherwise / on failure → `micSource → merger ch0`

This shape is what makes properties 2 and 3 achievable: nothing ever calls
`stop()` on a track or drops the `MediaStream`, so falling back is one
`connect()` away and the mic is guaranteed still live.

---

## The four properties — each verified, each red-checked

Founder's wording, with what "not vacuous" means for each:

1. **Existing path unchanged when Tier 1 is unavailable.**
   With `engineAvailable: false`, the graph must be byte-for-byte the path
   shipped in 1.2.6. Prove it by asserting the *absence* of any Tier 1 node
   and the presence of the `micSource → merger` edge — not merely that
   recording "works".

2. **Raw mic never disconnected. Assert directly.**
   This is the dangerous one. Assert on the **track and stream objects**:
   `micTrack.readyState === 'live'`, `stream.active === true`, and that
   `stop()` was never called on the track — spy on it. Do **not** assert
   something that is true regardless of the code under test. Before trusting
   it, break the code on purpose and watch this specific assertion go red.

3. **Pipe killed mid-stream → transcript survives on raw audio.**
   Start with Tier 1 active and audio flowing, then emit the pipe drop.
   Assert chunks *continue* arriving at `onChunk` afterwards, and that they
   are raw-sourced. A test that only asserts "no throw" is vacuous here.

4. **Its own commit, red-then-green.**
   Not folded into the merge sweep. Revert the fix, watch the tests go red for
   the *right* reason, restore, watch green. If reverting leaves them green,
   the tests do not discriminate — fix the tests before shipping the code.

---

## Then, and only then

1. Merge M27 + Tier 1 → `main`, version **1.3.0**
2. **Real** `npm run typecheck` and full suite on merged main — exit codes read
   directly. No `| tail`, no `; echo`. (Species 14 has recurred three times in
   this project, twice in commands typed *by the assistant that had just
   documented it*.)
3. Bundle-verify through the staleness gate; confirm the artifact is fresh
   against the exact commit, and that it contains **both** the M27 fixes and
   `resources/virtualmic-win/{kern_bridge.exe, DeepFilterNet3_onnx.tar.gz}`
4. **Publish.** The founder has authorized this explicitly and repeatedly.
   Do not hold for second-machine verification.
5. Confirm live: fetch `latest.yml` from the real URL, confirm `version: 1.3.0`

---

## Release notes / STATUS.md must say plainly

Verified:
- Engine proven on a **clean-install artifact**, on **one machine**
- Renderer wiring tested at **unit / integration level only**

Not verified:
- **End-to-end on a genuinely separate machine**
- NSIS install/uninstall behaviour
- Audio quality by ear
- Driver-absent call flow end to end

Plus, in plain language for users: noise cancellation is **new for Windows**,
works **with no driver installed**, and the driver (which routes cleaned audio
into Zoom/Teams) is a **separate optional install** with its own requirements.

This is not hedging. It is what makes a field failure diagnosable in minutes
instead of guessed at blind.
