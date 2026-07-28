# Session health — the lag, drift and liveness model

This document explains the subsystem in `src/main/session-health/`, why it
exists, and how to read what it reports.

## Why this exists

Every serious bug the transcription pipeline has had presents as **healthy**.
The socket says `OPEN`, the stream says active, callbacks keep firing,
`readyState` never changes — and nothing works.

That is not an accident, it is a property of the stack:

- **TCP cannot tell you the path died.** A Wi-Fi drop that sends no FIN leaves
  `readyState === OPEN` for the entire retransmit window, which is minutes.
- **A quiet meeting and a dead microphone are byte-identical** from inside the
  process. Both deliver frames of zeros.
- **A machine that slept looks like a machine that was busy**, unless you
  compare two different clocks.

So the health layer measures the things that _do_ differ, and turns each one
into a number a human can act on.

## The three measurements

### 1. Lag — two cursors (`lag.ts`)

```
X = seconds of audio SUBMITTED to Deepgram   (cumulative, across reconnects)
Y = seconds Deepgram has ACKNOWLEDGED        (start + duration of the latest result)
lag = X − Y
```

The important word is **cumulative**. Deepgram restarts its own audio clock on
every connection, so a naive counter has to reset to 0 on each socket open —
which is exactly what the old implementation did, and it meant the metric was
_structurally incapable_ of observing lag carried across a reconnect. That is
the case it existed to catch.

`LagTracker` instead records where the cumulative cursor stood when the current
connection opened (`ackBaseSec`) and maps each connection-relative
acknowledgement back onto the session-wide scale.

Sampled at 1Hz. **The watchdog always acts on a 5-sample median, never an
instantaneous reading** — one late interim result is not a sick pipeline.

| Median lag | Tier    | Action                                                |
| ---------- | ------- | ----------------------------------------------------- |
| < 2s       | healthy | nothing                                               |
| 2–5s       | warn    | surfaced only                                         |
| 5–15s      | shed    | trim the queue to the replay cap                      |
| ≥ 15s      | reset   | drop the backlog, rebuild the socket at the live edge |

**Plus the ratchet guard.** Lag that only ever climbs never self-heals: Deepgram
ingests at 1.25× realtime, so a realtime producer claws back **0.25× per
second**. Ninety seconds of backlog needs six flawless minutes to clear. The
guard splits the trailing 30s into six buckets, takes each bucket's median, and
trips a reset when every bucket is ≥ the one before it (within 0.1s) and the net
rise is ≥ 1.5s — regardless of the absolute value. This fires while the number
still looks fine, which is the only time the fix is cheap.

Resets are budgeted: **max 3 per 10 minutes**, with backoff. Past the budget the
verdict degrades to `shed` rather than `reset`, because an unbudgeted reset loop
is a reconnect storm that looks identical to the bug it is trying to fix.

Silence injected to keep the socket alive (see liveness, below) advances
Deepgram's audio clock without being real audio, so it is tracked separately and
subtracted back out of the acknowledgement. Otherwise a long muted stretch buys
the pipeline acknowledgement credit it never earned.

### 2. Drift (`drift.ts`)

Per frame, record `(monotonicMs, cumulativeSamples)`; least-squares fit over 60s:

```
ppm = (slope / nominalSamplesPerMs − 1) × 1e6
```

A healthy consumer clock sits within roughly ±100ppm. A discontinuity larger
than 200ms in a single frame is **not drift** — it is a device event or a
suspend — so it trips a resync instead of being folded into the estimate.

> **Not implemented, deliberately: the adaptive PI resampler.** The mic and the
> loopback share one `AudioContext` through a `ChannelMergerNode`, and Chromium
> already resamples each source into the context clock with its own drift
> compensation. The two channels are sample-aligned before this code sees them —
> which is why the original design chose a single context. A second controller
> would fight the first. And differential mic-vs-loopback drift is not even
> measurable from the main process: both sources have already been resampled
> onto the shared clock, so the differential is zero by construction. What is
> measurable, and what this meter reports, is the aggregate context clock
> against the rate we declared to Deepgram.

### 3. Liveness (`liveness.ts`)

Three independent clocks, because they fail independently:

| Signal                                           | Meaning                            | Response                            |
| ------------------------------------------------ | ---------------------------------- | ----------------------------------- |
| No audio callback for 10s                        | capture device is gone             | `capture-dead` → reacquire          |
| Callbacks arriving, all digital silence for 10s  | suspicious, not fatal              | `silent` → log and surface **only** |
| No server message for 10s while actively sending | socket is dead, TCP hasn't noticed | `socket-dead` → rebuild             |

The middle row is deliberately non-fatal. Tearing down a working session because
nobody spoke for twelve seconds would be far worse than the bug it guards
against.

**Silence fill.** Deepgram closes with `1011` / `NET-0001` when no audio arrives
within ~10s of a socket opening, and **KeepAlive messages do not satisfy that
deadline — only audio does**. So a muted or paused call still sends a 20ms
silent frame every 3s. A zero-length frame is not a substitute: it reads as
end-of-stream.

## The shed policy

The queue is bounded in **seconds of audio (10s cap), not bytes** — bytes
silently change meaning when the channel count or sample rate does.

Three rules, two of them counter-intuitive:

1. **Drop from the head (oldest), never the tail.** Dropping the newest frame is
   the intuitive choice and it is wrong: it keeps the pipeline permanently
   behind, transcribing stale audio forever. Dropping the oldest costs the words
   already missed and returns you to the live edge.
2. **Evict silence before speech.** A backlog in a real sales call is mostly the
   gaps between turns, so an energy-gated eviction usually clears the entire
   overflow without losing a single word.
3. **Never replay a large disconnect buffer.** Cap replay at 3s; discard the
   rest and emit a gap marker. Deepgram's own documentation recommends buffering
   while disconnected — **followed without a cap, that recommendation is what
   manufactures the lag ratchet.**

Backpressure comes from `ws.bufferedAmount`. Previously every frame went
straight to `ws.send()`, which never blocks and never refuses — it just queues
internally, without bound.

### `bufferedAmount` is a real signal, but a late one — measured

It is tempting to treat `bufferedAmount` as _the_ backpressure fix. It is not,
and the gap matters enough to have been measured on loopback:

| Audio pushed into a black-holed socket | `bufferedAmount` |
| -------------------------------------- | ---------------- |
| 60s (1.92 MB)                          | **0**            |
| +300s (11.5 MB total)                  | 7.5 MB           |

The kernel socket buffer absorbs the first several megabytes, and data sitting
there is invisible to `bufferedAmount` and already beyond the queue's reach. At
16kHz mono that blind spot is roughly **two minutes of audio** — which means
`bufferedAmount` alone would **not** have caught the original 90-second bug.

So the defences are layered, and it is worth being precise about which one
covers which failure:

| Failure                          | What actually catches it                      |
| -------------------------------- | --------------------------------------------- |
| Clean disconnect (socket closes) | Bounded queue + replay cap                    |
| Slow-but-alive socket            | `bufferedAmount` high-water mark              |
| **Half-open socket (no FIN)**    | **Liveness watchdog — 10s of server silence** |
| Gradual degradation              | Lag ratchet guard (rising slope)              |

The half-open row is the original bug, and the watchdog is what bounds it: at
most ~10s of audio can disappear into the kernel before the session is rebuilt
at the live edge, which discards the kernel buffer along with the socket.

## Gaps are shown, not hidden

Discarded audio produces a `[gap: 34s]` marker inline in the transcript
(`kind: 'gap'` on a `CallSegment`). An honest hole is far more useful than a
seamless-looking splice of two moments minutes apart.

Gap markers are **stored and rendered but never treated as speech**:
`speechSegments()` in `calls-fs.ts` filters them out of every path that counts
words, measures talk ratio, identifies a speaker, verifies a quote, or prompts a
model. Otherwise `[gap: 34s]` becomes three words spoken by speaker 0, quietly
skewing every derived metric.

## Timeline

`SessionTimeline` owns time for a session. **`performance.now()` is the only
timeline source**; wall clock is recorded once at session start, as metadata.

`Date.now()` can step backwards (NTP), forwards (user edit), and stalls across
sleep differently per platform. Anything deriving an _elapsed_ value from it
produces a wrong answer no test catches, because the wrongness only appears on
the machine whose clock moved.

`SleepDetector` uses the divergence between the two clocks to notice a suspend,
rather than Electron's `powerMonitor` (which fires twice on macOS and sometimes
not at all). `powerMonitor` remains useful as a faster _hint_, never as the
mechanism.

## Reading a health snapshot

The main process emits `transcription:health` at 1Hz:

```jsonc
{
  "submittedSec": 412.3, // X — cumulative audio handed to the socket
  "acknowledgedSec": 411.8, // Y — same scale, silence-fill subtracted out
  "lagSec": 0.5, // instantaneous X − Y
  "medianLagSec": 0.4, // what the watchdog acts on
  "tier": "none", // none | warn | shed | reset
  "queuedSec": 0.04, // waiting in the bounded queue
  "shedSec": 27.1, // deliberately dropped this session
  "resets": 1,
  "gaps": [{ "atMs": 130400, "durationMs": 27100, "reason": "reconnect" }],
  "liveness": "ok" // ok | silent | capture-dead | socket-dead
}
```

**How to read it:**

- `queuedSec` persistently above ~0.5s means the socket is not keeping up —
  look at the network before looking at the code.
- `shedSec` climbing with `tier: "none"` is the system working: it dropped
  silence and stayed at the live edge.
- `medianLagSec` low but `resets` climbing means the **ratchet guard** is
  firing — lag was rising steadily even though it never looked bad.
- `liveness: "silent"` with a non-zero `submittedSec` is the Teams-style
  failure: audio is flowing but it is all zeros. Check the capture endpoint,
  not the socket.
- A `reason: "sleep"` gap is the machine having been suspended. The buffer was
  discarded rather than replayed — twenty minutes asleep would otherwise be
  eighty minutes of lag at a 1.25× ingest cap.

`transcriptionHealth()` exposes the same snapshot plus `driftPpm` to the
`--diagnose` report.
