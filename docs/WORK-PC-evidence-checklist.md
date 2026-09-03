# Work-PC evidence checklist — one sitting, in order

Everything needed for the three open items. **Order matters for step 1** — do it
before touching or restarting the app.

Written 2026-09-03. Anything the app *syncs* is deliberately not on this list:
**call records already reach the other machine**, so there is no need to send
call `.json` files. Only four files never sync, and one of those is just React
stack traces.

---

## STEP 1 — the API keys page, BEFORE restarting anything

**Do this first, and do not quit or restart CallRise before you do.** BUG-148's
demotion lives in memory. A restart clears it, and an absent notice would then
be meaningless — it could equally mean *"cleared legitimately on restart"* or
*"never fired at all"*, and those are opposite answers.

1. Open **Settings → API keys**.
2. Screenshot the **whole page**, not just the OpenAI card — the other cards are
   the control. If OpenAI shows nothing unusual but Groq shows a demotion
   notice, that is a different finding from nothing showing anywhere.
3. Screenshot it **whether or not** a notice is visible. "No notice" is the
   result if that is what is there; a missing screenshot is not.

There is no file to send for this one. The screenshot is the evidence.

*(Why this matters: the fallback log recorded **64 "Your OpenAI API key was
rejected"** events, 59 of them on 1 September alone. If a rejected key was hit
59 times in a day, either the demotion is not taking hold, or it is working as
designed — reordering rather than removing — and 59 attempts is the cost of
that design. The screenshot decides which.)*

---

## STEP 2 — one call, watching one thing

Start a call and **watch the transcript area for the first 60 seconds**. The
only question:

- **(a) STALLING** — text appears, then stops.
- **(b) NEVER** — no text appears at all, from the start.

Those point at different halves of the audio path, so a one-word answer is worth
more than any file. If the call transcribes normally, that is also an answer —
say so, and note roughly how long the app had been open.

If the call **does** fail, note the **time it started**. That is what ties it to
a line in the health log.
**The single most valuable bit, added 2026-09-03:** once you have the health log
(Step 3), the failing call's line answers BUG-D's open question by itself —
does it read `multichannel=true` or only `multichannel=false`? See
`docs/BUG-D-mechanism-narrowing.md`. You do not need to check this yourself; just
send the log and note the failing call's start time.

**What the two outcomes look like, so you can tell a good file from a broken one.**
You are not diagnosing — this is only so that if the file is truncated or the
failing call is missing from it, you know to say so rather than assume it is fine:

- The failing call should appear as **at least one line** whose timestamp is near
  its start time, reading `multichannel=false`.
- **Branch A** — that line is followed by a `multichannel=true` line for the same
  call: the switch to two-channel capture succeeded. (Points downstream — audio
  or ASR.)
- **Branch B** — there is *only* the `multichannel=false` line, no
  `multichannel=true` after it: the switch never completed. (Points at the
  restart step.)

Either branch is a result. What is NOT a result: **no line near the call's start
time at all** — that means the file was truncated, the wrong file was sent, or the
call did not reach the point of logging. If you see that, say the file looks
incomplete rather than letting it read as Branch B (which it would resemble).

---

## STEP 3 — collect the files that never sync

Paste this into PowerShell as one line. It creates a dated folder on the Desktop
and opens it:

```powershell
$d = "$env:USERPROFILE\Desktop\callrise-evidence-$(Get-Date -Format yyyyMMdd-HHmm)"; New-Item -ItemType Directory -Force -Path $d | Out-Null; Copy-Item "$env:APPDATA\sales-os\session-health.log","$env:APPDATA\sales-os\ai-fallback-events.jsonl" -Destination $d -ErrorAction SilentlyContinue; Copy-Item "$env:APPDATA\sales-os\logs\callrise.log" -Destination $d -ErrorAction SilentlyContinue; Get-Process | Where-Object { $_.ProcessName -like '*allRise*' -or $_.ProcessName -eq 'electron' } | Select-Object ProcessName,Id,StartTime,Path | Format-List | Out-File "$d\app-process.txt" -Encoding utf8; explorer $d
```

Tested end to end on the other machine; it collects five files and opens the
folder. **It also records the app's `StartTime`**, which is what settles Step 1's
"has this been restarted?" question without anyone having to remember.

### What it gathers, and why

| file | why | size, roughly |
|---|---|---|
| `session-health.log` | **the main one.** One line per call end, with `multichannel=`, `resets=`, `submittedSec=`, `acknowledgedSec=`. **Send the whole file** — it is ~20 KB and a range risks cutting the line that matters. A mono↔multichannel switch mints a NEW session, so one call can produce several lines | ~20 KB |
| `ai-fallback-events.jsonl` | the 64 OpenAI auth rejections, and whether the Groq tool-schema failure is still happening after BUG-162 | ~200 KB |
| `app-process.txt` | the app's start time — decides whether an absent demotion notice means anything | 1 KB |
| `callrise.log` | optional. Mostly React stack traces; occasionally shows the transcription lifecycle on a real failure | ~90 KB |

**Nothing here contains transcript text, contact details or credentials.**
Checked: the health log is counters only, the fallback log is
purpose/reason/detail with no content, and `app-settings.json` was examined and
is deliberately **not** on this list.

---

## STEP 4 — send

Zip the folder, or send the files. With them, say:

1. **stalling or never** (Step 2), and the **start time** of any failing call;
2. whether the **API keys page** showed a demotion notice (screenshot either way);
3. anything odd you noticed that is not in a file.

---

## The one thing that would be worth more than all of this

A reproduction of BUG-D needs **audio known to contain speech**, submitted,
acknowledged, and returning near-zero words. Clause one is what nothing on the
other machine can establish — 89 of its 90 calls transcribe nothing, almost
certainly a silent room rather than the bug.

So: **if a call fails while you are genuinely talking, that call is the
evidence.** Note its start time and it can be matched to its health line. That
single call is worth more than every local test.
