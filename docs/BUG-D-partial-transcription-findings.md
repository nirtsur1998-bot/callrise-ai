# BUG-D — "some calls transcribe fully, some capture only ~20%"

**Status: mechanism NOT established. One strong correlation found; the obvious
causal explanation for it was tested and disproved.**

Founder's brief: *"I want the actual mechanism, measured. Not 'probably the
buffer.'"* This file records what is measured, what is ruled out, and what the
next test is — including the parts that went against me, because two separate
metrics in this investigation produced confident wrong answers before being
thrown out.

Dataset: the founder's own profile, 341 saved call records, of which 129 are
≥2 minutes with a non-empty transcript. All numbers below come from those files.

---

## Two metrics discarded before any conclusion

Both looked like findings and were not. Recording them because the failure mode
repeats.

1. **Coverage via `endMs`** — a transcript-span-over-duration metric was built on
   a field that does not exist on a segment. It reported 158/158 calls truncated.
   Discarded.

2. **Coverage via `epoch`** — the second attempt used `segment.epoch` as a
   timestamp. It reported 0.0% coverage for all 110 calls, which is what prompted
   a look at the raw values: **every segment in a 45-minute call carried
   `epoch: 8`**, one distinct value across 216 segments. `epoch` is not a time.
   It is `speakerEpoch`, bumped on every Deepgram (re)connection
   (`transcription.ts`, `s.speakerEpoch = nextSpeakerEpoch++`), because Deepgram
   restarts diarization per connection and speaker labels must never merge
   across one.

   The mistake produced the investigation's only real lead.

3. **`submittedSec` from `session-health.log`** — withdrawn earlier in the same
   investigation: health lines were matched to their nearest call without a
   time-gap filter, so one line was attributed to a call 50 minutes away,
   producing "8 seconds submitted for a 51-minute call". Redone with a 2-minute
   threshold, the real ratios were 54–108%.

---

## What IS measured

### Reconnect count predicts thin transcripts, and it is not call length

Distinct `speakerEpoch` values per call = number of Deepgram connections.

| distinct epochs | calls | mean words/min | mean confidence |
|---|---|---|---|
| 1 (no reconnect) | 81 | **99.9** | 0.797 |
| 2 | 6 | 119.7 | 0.761 |
| 4 | 6 | 47.6 | 0.666 |
| 7 | 2 | 47.0 | 0.625 |
| 10 | 2 | 36.1 | 0.649 |
| 16 | 1 | 27.4 | 0.722 |
| 24 | 1 | 21.1 | 0.558 |
| 47 | 1 | 21.7 | 0.623 |

Controlled for duration — the relationship holds inside every band, so it is not
"long calls reconnect more":

| call length | 1 epoch | ≥3 epochs |
|---|---|---|
| 2–10m | 99.5 wpm (n=35) | 47.5 wpm (n=8) |
| 10–25m | 98.6 wpm (n=33) | 56.2 wpm (n=4) |
| >25m | 104.2 wpm (n=13) | 45.8 wpm (n=5) |

Calls that carry `[gap: Ns]` markers: **42.4 wpm, mean 9.36 epochs**.
Calls without: **88.2 wpm, mean 1.33 epochs**.

### A control that did NOT support the finding

Reconnect **rate** (epochs per minute) vs words-per-minute:
**Spearman ρ = −0.277**, and the middle rate bucket is non-monotonic (0.11–0.3/min
has the *highest* density at 104.3 wpm).

So the predictor is the **count** of reconnects, not how often they occur. A short
call with two drops has a high rate and little damage. Any future write-up that
quotes the count relationship without this line is overstating it.

---

## What is DISPROVED

**Reconnects do not damage transcripts by discarding buffered audio.**

This was the obvious mechanism, and the code supports the story: on every
reconnect `transcription.ts` runs

```js
if (s.connectedOnce) {
  const dropped = s.queue.trimToReplayCap()
  queueShed(s, dropped.droppedSec, 'reconnect')
}
```

— buffered audio beyond the replay cap is deliberately dropped, because
unbounded buffering "manufactures the ratchet". Each shed is written into the
transcript as `[gap: Ns]`, so the cost is visible per call rather than inferred.

Measured across all 129 calls:

- 11 calls carry gap markers.
- **Total audio dropped across all of them: 58 seconds.** One minute, in aggregate.
- Worst single call: **20s out of 36.3 minutes = 0.9% of the call.**

A 0.1–0.9% audio loss cannot produce a 50–80% word deficit. The discarding is
real, bounded, and honestly marked — and it is not the mechanism.

`session-health.log` cannot corroborate either way: 38 sessions, 1 with a reset,
all recent test sessions rather than the historical calls.

---

## The next test

Mean Deepgram **confidence falls with epoch count** — 0.797 at one epoch,
0.558–0.649 at 10–47. That is the shape of a **common cause** rather than a
causal chain: some degraded audio condition that both trips reconnects *and*
worsens recognition, rather than reconnects costing the words.

Candidates, in the order worth testing:

1. **Confidence as mediator.** Partition calls by mean confidence rather than by
   epoch count and see whether epoch count still predicts wpm inside each band.
   If it does not, confidence (i.e. audio quality) is the real variable.
2. **Input device.** Not currently on the call record. Would need capturing.
3. **The denoiser.** Whether "Clean my microphone" was on is not on the record
   either; the virtual mic could plausibly affect both.

## What would close it properly

Gaps are tracked in the session (`s.timeline.gapMarkers()`) and emitted, but the
call record persists only the in-text markers — there is no per-call field for
dropped seconds, reconnect count, device, or denoiser state. Persisting those
four on the call record turns every future call into its own evidence, instead
of this kind of archaeology across 341 JSON files.
