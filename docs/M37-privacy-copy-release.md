# Release proposal — the privacy copy, alone

**Prepared 2026-09-07. Version and rollout are the founder's. Nothing is tagged or published, and
the three copy strings are NOT committed pending their word-by-word approval.**

## What ships

**Three strings, and nothing else that a user can see.** No migration, no default change, no
behaviour change. It takes effect for every user, new and existing, the moment it installs.

| # | Site | Removes |
|---|---|---|
| 1 | `SalesBrainSection.tsx:174` — the Sales Brain card | "Runs entirely on your own device … never uploaded anywhere by default" |
| 2 | `settings-nav.ts:199` — nav entry | "Runs entirely on your own device." |
| 3 | `settings-nav.ts:418` — nav entry, design-preview variant | "Runs entirely on your own device." |

"Off by default" is **kept** in 2 and 3. It is true: the Sales Brain feature itself defaults to
`enabled: false`. It was never the false part.

Riding along, because the founder asked for it in the same breath and it changes nothing a user
sees: the erase paths (`b9cd684`) — both delete branches, the exhaustive scrub-key set, and the
`else` that throws. Those are a *capability* addition, not a copy change, and they are inert until
someone switches a category off.

## Version: **1.11.1**, if 1.11.0 has shipped by then. Otherwise fold into 1.11.0

A patch, not a minor. Nothing changes for anyone except what the screen says, and what it says now
is false. If 1.11.0 has not yet gone out, this belongs inside it rather than chasing it — the copy
should not ship second.

## Rollout: **100 %, immediately**

The founder's standing reasoning applies with extra force here. A staged rollout would leave a
known-false privacy claim on screen for the unstaged cohort, for no signal worth having. There is
no failure mode to watch for: the change cannot break a call, a sync, or a store.

## The release note, in the user's words

> **What the Sales Brain card said about your data was wrong, and we have fixed the words.**
>
> The card said your Sales Brain "runs entirely on your own device" and was "never uploaded
> anywhere by default". That was not accurate. If you are signed in and cloud backup is on, your
> Sales Brain is included in that backup, as it has been since the backup feature learned about it.
> Nothing about what the app does has changed in this release — only what it tells you.
>
> You can see and change exactly what is backed up in **Settings → Backup**.

**Say it plainly and do not bury it.** This is the release note a user should be able to read in
full without following a link.

## What this release deliberately does NOT do

- **It does not turn the upload off.** That is a real decision with a real cost — a user relying on
  the backup would lose it silently — and flipping the default would not even reach existing
  installs (`sanitizeSyncScope` reads the stored value). It needs an override-with-notice migration,
  and it is the founder's call.
- **It does not delete anything already uploaded.** The client can now ask, but the backend refuses
  until `supabase/2026-09-erase-paths.sql` is run. That is a separate, deliberate step.
- **It does not encrypt the upload.** Still raw bytes, whole file, every cycle.

## Before the tag

Nothing to drive. There is no UI behaviour to walk: the strings render in a card and a nav list that
already have render coverage. The one check worth doing is reading the three replacements on screen
once, which is a thirty-second look at Settings after installing.

## After publishing — the same five checks

From `docs/release-feed-verification.md`, with the tag filled in. Unchanged from every previous
release; this one adds no new asset and no new feed behaviour.
