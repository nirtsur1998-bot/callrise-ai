# BUG-D — narrowing the mechanism from code, no new evidence needed

**Written 2026-09-03**, attacking BUG-D from the code and the local
`session-health.log` rather than waiting on the work PC. It does **not** solve
BUG-D. It narrows the remaining hypothesis space to a single step, and — the
useful part — makes the founder's already-pending log **decisive** instead of
exploratory.

Everything marked VERIFIED was read from the shipped code or measured from the
local log. Everything marked INFERENCE is labelled.

---

## The live-call audio path, as it actually runs (VERIFIED by reading)

1. A call starts. `useTranscription` calls `transcription.start({ producerId })`
   with **no `multichannel` flag** — so main opens the socket **mono**
   (`channels = 1`). This is by design and is true of every call.
2. If the rep may record the other party, the BUG-172 auto-attach effect fires
   once a call id exists and calls `enableOtherParty()`.
3. `enableOtherParty` opens `getDisplayMedia` for system-audio loopback, then
   calls `transcription.start({ multichannel: true, expectedSessionId })` — a
   **restart of the same call into a two-channel socket**.
4. Main accepts the restart **only if `session.id === expectedSessionId`**.
   Otherwise it returns `{ ok: false, error: 'stale' }` (`transcription.ts:1146`)
   and the socket **stays mono**.
5. On any `!ok` (stale, or a `getDisplayMedia` denial/no-audio), the renderer
   runs `recorder.detachLoopback()`, sets `otherPartyError`, and **the call
   continues mono for its entire duration** (`useTranscription.ts:926`).

**So there is exactly one step whose failure produces a permanently-mono call:
the multichannel restart at step 3–4.** A mono call cannot attribute a buyer
channel, which is precisely the BUG-D / BUG-182 shape: one voice, no channels,
"the buyer was never recorded" indistinguishable from "the buyer said nothing".

## The restart is visible in the health log — for free (VERIFIED)

`teardown()` logs a session summary (checked: `logSessionSummary` is called
inside it), so **both** phases of a switched call appear:

```
session=1 ... multichannel=false   ← the mono phase, before the switch
session=3 ... multichannel=true    ← after a SUCCESSFUL switch
```

A call whose switch **failed or never happened** leaves only the
`multichannel=false` line, with **no `multichannel=true` session following it**.
That difference is readable with no transcript, no words, nothing but the log.

## What the local log already shows (VERIFIED, with its limit stated)

39 app launches in the assistant's local `session-health.log`:

| | |
|---|---|
| launches that opened mono | **36 / 39** |
| ...that **never** switched to multichannel | **23** |
| ...that ran ≥45s mono and never switched | **10** |

**The limit, stated plainly:** these are silent-room test calls, and screen
share for loopback is almost certainly never granted here — so "stayed mono" on
this machine is very likely the *innocent* no-loopback path, not the bug. This
is **not** evidence that the switch fails in the field. It is evidence that the
switch **frequently does not complete**, and that when it doesn't, the result is
byte-for-byte the BUG-D shape.

## Why this matters even though it proves nothing on its own

It collapses BUG-D's open question into a **binary the pending log answers
directly**:

- **If the founder's failing calls show a `multichannel=true` session** → the
  switch succeeded, the socket was two-channel, and Deepgram returned nothing
  anyway. The fault is downstream of capture (audio content, or ASR).
- **If they show only `multichannel=false`** → the switch never completed, and
  BUG-D is a **failure of the multichannel restart** (step 3–4). The suspects
  then narrow further to three, each already in the code:
  1. `stale` — `sessionIdRef` diverged from main's `session.id` before the
     attach (a reconnect or a second start landing in between);
  2. `getDisplayMedia` denied — the OS refused loopback;
  3. `no-audio` — loopback attached but carried no audio track.

That is a genuinely different next step for each branch, decided by a log the
founder is already going to send — instead of "read the log and see what jumps
out".

## The one line to add to the evidence checklist (done)

For any failing call, the question is no longer "send the log". It is:

> **Does that call have a `multichannel=true` line, or only `multichannel=false`?**

A single call with a person genuinely talking, plus that one bit, splits BUG-D
in half.

## What was NOT claimed here

- Not that the switch fails in the field — the local data cannot show that.
- Not a log-undercounting bug — `teardown` was checked and it does log the
  switched-away mono phase, so an earlier suspicion was wrong and is dropped.
- Not a mechanism for `stale`. The condition is identified; *when* the session
  ids diverge is not established, and inventing it would be a fabricated
  mechanism of exactly the kind M33 is under standing orders to avoid.
