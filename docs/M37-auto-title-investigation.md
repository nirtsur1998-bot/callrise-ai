# Why calls end without a title

**2026-09-08. Measured against your real profile, read-only. Nothing changed.**

You said maybe 30% of the time it happens. **Measured: 28.3% of your calls have an AI title.** Your
instinct had the number right and the sign flipped — the failure is the common case, not the rare
one.

---

## The measurement

`%APPDATA%\sales-os\calls\*.json`, all 291 files, tombstones excluded:

```
live calls                191
still "Call · <date>"     137   (71.7%)
have a generated title     54   (28.3%)
```

By month, which is where it gets interesting:

```
2026-07     5 of  25    20%
2026-08    44 of 138    32%
2026-09     5 of  28    18%
```

**And the last AI title on your machine was generated on 2026-09-03.** Every call since — 09-07,
09-08, today — is untitled. That is not a degradation, it is a stop.

It is also not thin transcripts. The untitled calls are full-length: median 608 words, 48 segments,
8m42s. Two of the 137 have zero segments. The titled and untitled populations are the same shape.

---

## The cause, for you specifically: the preference lives in localStorage, and you changed origins

I read it out of the running app over its debug port rather than guessing:

```
origin: http://localhost:5173
salesos.settings.autoGenerateTitle   null
salesos.settings.autoSummarize       null
salesos.settings.autoPostCallBrief   null
```

**All three AI Note Taker toggles are unset in the app you are actually using.** `getAutoGenerateTitle()`
is `read(key) === 'true'`, so `null` is off. The Settings screen is showing you those switches in the
off position right now.

You turned them on in the **packaged** app, whose renderer origin is `file://`. Your daily driver
since early September is the **dev** app, served from `http://localhost:5173`. localStorage is
per-origin. The two apps share `userData` — same calls, same contacts, same Sales Brain, same
settings file — but **not** these three preferences, because these three are the only ones that
never moved out of localStorage.

That explains the shape exactly: titles until 2026-09-03, none after.

---

## But that is your instance of a bug every user has

This is not a dev-versus-prod curiosity. `prefs.ts` holds these three in renderer localStorage, which
means for **any** user:

- **They are not in the backup.** `backup_settings` uploads `loadAppSettings()` — the AppSettings
  object. localStorage is not in it. So a user who reinstalls, or signs in on a new machine, gets
  every setting back except these three, silently, while the restore reports success.
- **The main process cannot read them.** `app-settings.ts:80-86` records that deal-intelligence and
  cue settings were migrated OUT of localStorage for exactly this reason, and matched their old
  defaults so no existing install noticed. The precedent and the migration shape are already in this
  codebase; these three were left behind.
- **Any origin change resets them.** Today that is dev-vs-packaged. A future build moving off
  `file://` to a custom scheme would do the same thing to every user at once, on upgrade, silently.

**BUG-227**, High. The fix is the migration that deal-intelligence already had.

---

## Four more, found on the way, each of which would still bite with the toggle on

**BUG-228 — the failure is silent at three layers.** The renderer fires
`void window.api.calls.generateTitle(id).catch(() => {})` (`useTranscription.ts:280`); the IPC
handler is `catch { return { ok: false } }` (`calls.ts:1188`); `generateCallTitle` is
`catch { return { ok: false } }` (`call-title.ts:50`). Nothing logs, nothing appears in the Job
Inspector, no toast. **A user cannot tell "the toggle is off" from "the AI call failed" from "it
worked and the title was bad"** — which is precisely why this went unnoticed for five weeks.

**BUG-229 — there is no manual "generate title" anywhere.** `generateTitle` has exactly one caller in
the whole tree, the automatic one. Compare `summarizeCall`, which has two buttons in `CallDetail`
plus the automatic call. So a call that misses its one shot can never be titled except by typing one
yourself — and that asymmetry is visible in your own data: 60 of your 137 untitled calls **do** have
a summary, because for summaries there is a button.

**BUG-230 — a recovered call never gets a title at all.** `recoverCall`
(`live-transcript-ipc.ts:110`) calls `saveCall` directly and then stops. No title, no summary, no
brief — none of the three auto-behaviours, regardless of the toggles, because those live in the
renderer's save path and recovery does not go through it. A call rescued after a crash is
permanently "Call · <date>".

**BUG-231 — one shot, no retry, at the busiest moment of the app's life.** It fires at call end,
concurrently with auto-summary, the coaching run, memory extraction and a backup push. `purpose:
'other'` gets `QUALITY_CHAIN` with a chain budget of 1, so one rate-limited moment and the title is
gone for good. It also requires a **tool call** (`record_title`) to succeed — the exact capability
BUG-195 measured as unreliable on free-tier models.

---

## What I would do, in order

1. **BUG-227** — migrate the three prefs into AppSettings, with the deal-intelligence migration as
   the pattern: defaults matching today's behaviour, seeded from localStorage on first run so nobody
   loses a setting they already made. This alone fixes your machine and every reinstall.
2. **BUG-229** — a "Generate title" item next to the existing Summarize button. Cheapest thing here,
   and it is the escape hatch that makes every other failure survivable.
3. **BUG-228** — record the attempt and its outcome where the Job Inspector can see it, so the next
   time this happens the answer takes a minute instead of an afternoon.
4. **BUG-230** — run the three auto-behaviours from the recovery path too, or say plainly on the
   recovery screen that they did not run.
5. **BUG-231** — retry once on the next app start for any call still holding a default title, if 1-4
   have not already made this moot.

**One thing I have not done: turn your toggles back on.** They are your settings and the switch is
one click in Settings → AI Note Taker; flipping them from here would also make the next measurement
meaningless. If you want the 137 back-titled once the toggle is on, that is a one-off runner and I
would rather build it after you have decided on BUG-227's shape.
