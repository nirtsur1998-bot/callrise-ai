# Speaker identification (M19 Task 2)

This document explains the subsystem in `src/main/speaker-identity/` and
`src/renderer/src/features/coaching/meta.ts`'s identity-resolution additions,
what's implemented versus deliberately stubbed, and the Deepgram cost finding
the milestone brief required before committing to the multichannel approach.

## The identity key

Every consumer keys on `speakerIdentityKey({speaker, channel})`
(`calls-fs.ts`) — `ch0/spk0` / `ch1/spk1` for multichannel calls (where
`speaker` and `channel` are the same value by construction — see
`transcription.ts`), `mono/spk0` / `mono/spk1` / … for mono/diarized calls.
This is the brief's own requirement: *"the identity key is (channel_index,
speaker) — always."* The renderer's `speakerKey()` (`features/live/segments.ts`)
and the main process's `speakerIdentityKey()` are independent, deliberately
identical implementations (main cannot import renderer code) — if you change
one, change the other.

## Storage: `Call.speakerIdentities`

A small `Record<string, SpeakerIdentityRecord>` on each saved `Call`
(`calls-fs.ts`), resolved once and cached. This is the entire retroactive-
rename mechanism: nothing else in a saved call — segments, summaries,
coaching evidence, exports — ever stores a name as text. They all resolve a
display name fresh, from this record, at render/export time (confirmed by
dedicated research before writing any of this: every existing consumer
already worked this way for "You"/"Buyer"/"Speaker N", so adding a real-name
lookup in front of that logic was additive, not a rewrite). A rename is
therefore just editing one small record — instant, and correct for every
past and future view of that call, with no risk of a surface that baked the
old name into generated prose.

## The naming cascade (Part B)

Implemented in `speaker-identity/resolve.ts` (pure decision logic, fully
unit-tested) + `resolve-for-call.ts` (IO wiring, called automatically after
a call saves and again after coaching completes):

1. **User's own name** — `Settings → Personalization`'s name field, applied
   to the deterministic "me" key (channel 0 for multichannel; `repSpeaker`
   for mono, once known).
2. **Calendar attendee (1:1)** — `speaker-identity/calendar-match.ts` ports
   the renderer's proven `findCalendarMatches()` overlap algorithm to main
   (via new `getCachedGoogleEvents()`/`getCachedOutlookEvents()` exports on
   `google.ts`/`outlook.ts`). Only applied when **exactly one** non-"me"
   speaker key was observed in the call — a genuine 1:1. Two or more
   distinct speakers means picking one as "the" calendar attendee would be a
   guess, which this cascade refuses to make.
3. **Contact record match** — if the calendar attendee's email matches a
   saved contact (`contacts-fs.ts`'s `findContactByEmail`, added this
   milestone along with real email normalization and `phoneE164`), the
   contact's own name wins over however the calendar invite happened to
   spell it, and the identity is linked to `contactId`.
4. **Meeting-app participant list — NOT IMPLEMENTED.** See
   `speaker-identity/participant-list.ts`'s header for why: no
   accessibility-tree/UI-automation capability exists anywhere in this repo
   to build on (confirmed by research reading both native addons in full).
   Real implementation is genuine new native work on both platforms, not a
   wiring task — stubbed rather than written blind, matching this repo's own
   precedent (the EFX registration mistake documented in the driver
   project's CLAUDE.md, and `docs/windows-capture.md`'s per-process-loopback
   addon being designed but not coded without real hardware to verify
   against).
5. **Self-intro extraction** — `live-cue.ts` extends the *existing* M9
   live-coaching LLM call (which already reads the transcript to find the
   REP's self-intro) to also extract the BUYER's name, one round-trip
   instead of two. Gated behind `SpeakerIdSettings.allowSelfIntroExtraction`
   (default **off** — buyer speech reaching a third-party LLM for name
   extraction). This is the *only* source that can name someone during a
   call in progress (steps 2–3 need a saved `callId`), so it's also what
   makes the **live transcript** show a real name, not just the saved-call
   view.
6. **Voice profile — NOT IMPLEMENTED.** Schema-only
   (`speaker-identity/voice-profile.ts`): storage, retention (`retainUntil`,
   required on every record), and deletion are real; `matchVoiceProfile()`
   always returns `null`. No real embedding model exists in this repo, and
   this milestone deliberately does not add one — CLAUDE.md is explicit that
   a Python/ML backend is a later, separate phase. Faking a match with a
   cheap fingerprint would misidentify people with unearned confidence,
   which is the exact failure this whole cascade exists to avoid.
7. **Fallback "Speaker N"** — unchanged existing behavior; the cascade
   simply produces no entry for that key.

Settings (`app-settings.ts`'s `SpeakerIdSettings`): `enabled` (default
**on** — steps 1–3 never touch an LLM or a third party),
`allowSelfIntroExtraction` (default **off**), `voiceProfileMatching`
(default **off**, and inert regardless per step 6 above).

## Part A: the loudspeaker/echo problem

Per-channel attribution (channel 0 = mic, channel 1 = buyer loopback) is
only deterministic with headphones. On speakers, the buyer's voice comes out
of the speakers and back into the mic, so channel 0 can carry real buyer
speech too — Deepgram faithfully reports "channel 0" because that's the
channel the bytes physically arrived on; the acoustic leak happened upstream
in the room, which Deepgram has no way to see.

- **`session-health/crosstalk-gate.ts`** — a rolling per-channel RMS history
  (`channelRms`, the same primitive `buyer-silence.ts` already uses), fed
  every audio frame, queried per finalized multichannel Results message. If
  Deepgram's claimed channel disagrees with which channel actually had the
  energy, `transcription:crossTalkWarning` fires — a banner, never a silent
  reassignment. Ambiguous (both channels genuinely loud — real simultaneous
  talk) is explicitly **not** flagged; only confident dominance-mismatch is.
  **Scoped honestly**: checked per Deepgram *message* window (message-level
  `start`/`duration`), not true per-word timestamps — Deepgram's word-level
  `start`/`end` aren't threaded through this pipeline's `Results` parsing
  yet. Finer-grained per-word tagging is a natural next step, not done here.
- **`features/audio/headphones.ts`** — best-effort output-device-label
  heuristic (no OS API answers "are headphones on the rep's head" directly).
  `'unknown'` deliberately never warns, so a real headphone setup the
  heuristic doesn't recognize is never false-flagged.
- Both surface as dismissible banners in `LiveView.tsx`: a proactive one the
  moment buyer capture goes live (device-label heuristic), suppressed once
  the reactive one (confirmed cross-talk) actually fires.

**Verified**: the decision algorithms are real and fully unit-tested (16
cross-talk-gate tests including synthetic tones through the actual
interleaver for both the clean-headphones and loudspeaker-leak cases; 5
headphone-classification tests). **Not verified**: end-to-end behavior on a
real loudspeaker test call on real hardware — this environment cannot run
one. Matches this repo's own established honesty pattern for exactly this
kind of gap (`docs/windows-capture.md`).

## Deepgram multichannel cost — confirmed

The brief required this be checked *before* committing further to
multichannel, since Task 2 builds on the M12 multichannel path. Confirmed
directly from Deepgram's own pricing/docs (via web search, since this
environment has no Deepgram account to run a live billing test against):

> **Each channel is billed as a separate audio stream when multichannel is
> enabled — the total cost is the single-channel rate multiplied by the
> number of channels.** A stereo (2-channel) file costs exactly 2x the
> single-channel rate. Conversely, when multichannel is **not** enabled,
> Deepgram converts multichannel audio down to mono before billing — so the
> **existing mono+diarize fallback path costs the same as if buyer capture
> weren't happening at all.**

At Nova-3's real-time streaming rate of **$0.0048/min ($0.288/hr)** for one
channel, multichannel buyer-side capture costs **$0.0096/min ($0.576/hr)** —
an extra **$0.288/hour** on every call where buyer-side capture is active
(consent given, headphones assumed). This is a real, non-trivial per-call
cost multiplier the user should be aware of when deciding default settings
for buyer-side capture — not researched or reported before this milestone.

Sources: Deepgram's pricing page and developer docs, as summarized by
[Smallest.ai's 2026 pricing breakdown](https://smallest.ai/blog/deepgram-pricing-plans-cost-what-you-get-in-2026)
and corroborating search results; Deepgram's own FAQ ("How do you calculate
costs for multichannel audio?" on
[deepgram.com/pricing](https://deepgram.com/pricing)) could not be fetched
directly (client-rendered accordion), so this is reported as sourced
secondary confirmation, not a first-party quote — the user should verify
against their own Deepgram account/invoice before relying on this for
budgeting, since published rates change.

## Not yet built

- Meeting-app participant list (step 4) and voice-profile matching (step 6)
  — see their files' own headers.
- Per-word (not per-message) cross-talk confidence, and per-word confidence
  tags on stored segments (today's cross-talk signal is a live banner only).
- A "remember this person" UI affordance in the rename control — the IPC
  (`calls:setSpeakerName`) already accepts `rememberAsContactId`, no UI
  surfaces it yet.
- **Mic/loopback sample-rate alignment — checked, and it's a non-issue by
  architecture, not a gap.** The brief asks to "verify sample rates and
  frame alignment... fall back to mono if the check fails." No explicit
  check exists because none is needed: `session-health/drift.ts`'s own
  documented reasoning (§2) explains why — the mic and loopback share ONE
  `AudioContext` through a single `ChannelMergerNode`, and Chromium resamples
  both sources onto that shared context clock with its own drift
  compensation before this code ever sees the audio. The two channels are
  sample-aligned by construction; a second, independent aligner would fight
  the browser's own. There is no failure mode here to add a fallback for.
