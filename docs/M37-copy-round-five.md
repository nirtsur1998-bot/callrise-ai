# Round five — the copy, against the tree as it stands

**2026-09-08. Nothing user-facing here is committed. Every string is yours to approve or reject.**

---

# THE FRAMING: the destination taxonomy was incomplete, and that is why four rounds failed

Everything this project has written about privacy — every round of copy, every refutation, the
locality guard, the page's own nav description, the notice card at the top of it — has sorted data
into **two** boxes: *this device*, and *your backup*.

**There are three.** The audio of every call streams live to Deepgram (`transcription.ts:487`,
`wss://api.deepgram.com/v1/listen`), on every call, with no toggle. Nothing in the product has ever
said so. Nothing in this project's own analysis had a slot for it.

**Nothing was ever mis-sorted.** Every individual judgement — is this claim true, does this sentence
need a caveat, is this site accounted for — was made correctly against the categories in hand. The
categories were incomplete, and that is a failure with no error in it anywhere: each sort looks
right, each reviewer agrees, and the answer is confidently wrong for as long as the taxonomy goes
unexamined. It survived a founder, an assistant, several drafters and several adversarial verifiers,
because none of them were being asked the question that would have exposed it — *what are the
categories?* — and every question they WERE asked presumed the answer.

It is also how I came to state, with real confidence, that "call audio never leaves this device". I
enumerated the backup module completely and correctly. There was no third box to enumerate.

The practical form of the lesson: **when the same class of answer keeps coming out subtly wrong,
stop checking the answers and enumerate the categories they are being sorted into.** Recorded as
taxonomy species 91.

---

## The three destinations, verified

| destination | what reaches it | what a user can do about it |
|---|---|---|
| **Deepgram** | the raw microphone audio of **every call**, streamed live as it happens (`transcription.ts:487`) | nothing. There is no toggle. It is how the words appear at all |
| **your AI provider** | the verbatim transcript, whenever a feature reads a call — summary, coaching, task extraction, live cues, Sales Brain extraction — plus the derived facts once a night (BUG-224) | turn the feature off |
| **your CallRise backup** | tasks, calendar events, and every call's title, summary and quote-free coaching, always, while signed in (`backup.ts:1016-1018`); plus the seven categories you switch on | the toggles, and signing out |

The first row is the only destination with no control at all, and the only one the product has never
named.

**How this was derived.** I read the code for every claim below rather than taking any of it from the
earlier rounds, the pending list, or a review. Where I contradict something this project has already
recorded — and I do, twice — the file and line is there so you can check me rather than take it.

---

# 1. THE THIRD DESTINATION NEEDS ITS OWN SENTENCE

Not a caveat bolted to an existing line. A fact about the product, stated where someone is asking the
question.

### The sentence

> **Your call audio goes to Deepgram, live, as you speak.** That is the transcription service your
> key connects to, and it is how your words become text at all — it happens on every call, and there
> is no way to turn it off and still have a transcript.

### Where it belongs — two places, and I agree with your instinct on both

**1. The AI provider / key setup step in onboarding.** This is the only moment a user is thinking
about which outside services this app talks to, and it is before their first call rather than after
it. It is also where they paste the Deepgram key, so the sentence explains something they are
already doing rather than introducing a new worry.

**2. The Privacy & data opening card** (drafted in §4), where someone has gone specifically to find
out. Same fact, in the place people go to check.

**A third I would add, and it is the cheapest of the three:** the Deepgram key field itself, wherever
it appears in the API-keys screen. One line under the input. Someone typing a key into a box is
entitled to know what will be sent to it, and that is the single highest-intent moment in the whole
product for this sentence.

I have not written it into any of the three yet — you asked for the draft and the placement first.

---

# 2. "CALL RECORDINGS" — THE FIVE RENAMES

**The toggle label first, as asked:**

| # | file:line | current | replacement |
|---|---|---|---|
| **1** | `BackupCard.tsx:109` | `label: 'Call recordings & transcripts'` | **`label: 'Call transcripts'`** |
| 2 | `BackupCard.tsx:351` | "Call recordings & transcripts sync is ON — your buyer conversations are stored in your cloud account, not just this device." | "**Call transcripts sync is ON** — your buyer conversations are stored in your cloud account, not just this device." |
| 3 | `BackupCard.tsx:414` (on) | "Call recordings and transcripts sync too, since you turned that on above." | "**Your transcripts sync too**, since you turned that on above." |
| 4 | `BackupCard.tsx:415` (off) | "Your call recordings and transcripts never leave this computer unless you turn that on above." | "**Your transcripts aren't included unless you turn that on above. Your AI provider still receives them whenever a feature reads a call.**" |
| 5 | `PrivacyNoticeCard.tsx:9` | "Your call recordings, transcripts, knowledge base, and app settings live only on this device." | replaced wholesale — see §4 |

Row 4 is the one that changes meaning rather than wording, and it is the one that was promising
locality about something that streams out live.

### Why the word is wrong in both directions

**The app never writes a call recording to disk, and no recording is ever uploaded.**

- No audio in either backup payload: `callBackupPayload` (`calls-fs.ts:1296`) and
  `callFullBackupPayload` (`calls-fs.ts:1352`) carry metadata, summary, coaching, segments,
  bookmarks. No audio, no file reference.
- No audio in the buckets: `attachments` uploads `call.attachments` only (`backup.ts:719-724`);
  `sales-brain` uploads `memory.db`.
- Nothing writes call audio anywhere. A tree-wide search for `MediaRecorder`, `.webm`, `.wav`,
  `recordingsDir`, `saveRecording` finds exactly two audio writers, and neither is a call: the mic
  test (played back, discarded) and Rise voice notes (`assistant-ipc.ts:894`).

So the toggle promises an upload that never happens — a user who switches it on believing their call
audio is protected on a new machine is wrong, and would only discover it by losing the machine — and
its off-state sentence promises the audio stays here while it is streaming to Deepgram.

**No guard could have caught this, and I would rather say so than add one that implies otherwise.**
The locality test sweeps for sentences making a claim. `label: 'Call recordings & transcripts'` is
not a claim, it is a noun; the falseness is that the noun names nothing. The instrument for that is
someone asking "does this category exist?"

---

# 3. The seven pinned sites — five stand, two do not

The pending list has no `because` field. `ACCOUNTED_FOR` requires a written argument for every entry;
`PENDING_FOUNDER_APPROVAL` requires none. I checked all seven against the code, and **two are true as
written.** They were pinned by a sweep, and nobody has had to defend them since.

That asymmetry is backwards on its own: the list of things we call FINE carries an argument, and the
list of things we call LIES carries nothing. An unargued accusation rots exactly like an unargued
exemption, and it let two true sentences sit pinned as debt.

### Still false — five, with drafts

**A. `home/activationSteps.ts:167`** — *"Runs entirely on your own device."*

False three ways: extraction sends the transcript to the AI provider, reflection sends the facts
nightly, `memory.db` uploads to the `sales-brain` bucket when both toggles are on.

> Sales Brain remembers who you are, how you sell, and each client — so summaries and coaching stop
> starting from scratch every time. Facts are extracted through your own AI provider.

*(The locality sentence is removed rather than replaced. An activation step is one line; the full
account is on the card it links to, which you have already approved.)*

**B. `settings/MemoryCenterSection.tsx:375`** — *"Runs entirely on your own device. Nothing is sent
anywhere."*

This is the `cost` line of an off-state — the sentence whose whole job is to say what turning it on
will cost. It currently says it costs nothing.

> Uses your own AI provider: it reads your calls to extract facts, and reviews those facts once a
> night.

**C. `settings/PrivacyNoticeCard.tsx:9`** — the opening card. Drafted in full in §4.

**D. `backup/BackupCard.tsx:414-415`** — rows 3 and 4 of the rename table above.

**E. `settings/TelemetrySection.tsx:260`** — *"Nothing has been sent from this computer."*

Two problems. It is scoped by its surroundings to diagnostics but worded absolutely, on a privacy
screen, for a signed-in user who is syncing. And it is false in its own scope: the log is
user-deletable (`sent-log.ts`, Delete button at `:279`), so pressing Delete makes the app say nothing
was ever sent.

> This log is empty — no diagnostics have been sent since it was last cleared.

### Withdrawn — two, with the reason

**F. `coaching/CoachingView.tsx:43`** — *"Uses your existing coaching results — no extra AI calls,
nothing new leaves your device."*

**The locality half is true.** Skill tracking makes no AI call: `coach2:getProgress`
(`calls.ts:624`) reads stored `skills` off call summaries, and `focus-skill-fs.ts` has no network
code at all. Turning it on changes the outbound prompt only by a constant methodology string
(`coach.ts:89-94`) and a wider tool schema — no user data that was not already going.

**But there is a false claim in the same sentence, and it is not the one that was pinned.** Skills
are computed at coach time and only when the flag is already on (`coach.ts:541-562`), and nothing
recomputes them for past calls. So "uses your existing coaching results" is backwards: switch it on
and your existing coaching contributes nothing — the dashboard stays empty until you coach a new
call. "Scores every coached call" in the line above has the same problem.

**And the behaviour cannot be fixed instead of the sentence.** `computeSkillScores` needs
`benchmark` (built from the transcript) and `methodologyAdherence` (which comes out of the AI
response), so scoring past calls means re-coaching them — real AI calls, which is precisely what the
next clause promises not to do. The copy is the thing that has to change.

> **what:** Scores each call you coach against eight named selling skills and charts how each one
> moves over time, so you can see which is actually improving and pick one to work on. Scoring
> starts from your next coached call.
>
> **cost:** Uses the coaching you already run — no extra AI calls, nothing new leaves your device.

*(The true locality clause is kept verbatim, so the guard's pin stays valid and simply moves to
`ACCOUNTED_FOR` with its argument.)*

This is the one I would take from this round even if you take nothing else, because of its shape:
**the sweep pinned the clause it had a pattern for, and the false clause beside it went unread for
the same reason it was written — nobody was checking that half.** Recorded as taxonomy species 92.

**G. `home/AccountMigrationNoticeCard.tsx:63`** — *"Your calls, transcripts, contacts and Sales Brain
live on this computer and are completely unaffected."*

True as written. It says the data lives on this computer, which it does; it does not say *only*. And
"completely unaffected" is a claim about the Supabase project switch, which touches nothing local.
The guard matched it because the pattern is deliberately wide and the sentence wraps across two lines
— a true positive for the net, a false one for the finding.

**Both move to `ACCOUNTED_FOR` with those reasons, and `PENDING_FOUNDER_APPROVAL` gains a `because`
field so the next entry has to be argued.** The count guard goes 7 → 5 and stays red in both
directions.

---

# 4. The opening card, and the page heading you held for this round

`PrivacyNoticeCard` is the first thing on Privacy & data, and its own doc comment calls it "a short,
honest recap". It is the sentence that has to carry the three destinations, because every card below
it is about one of them.

**Draft — the long version, which I recommend:**

> **Where your call data goes.**
>
> **Deepgram** receives the audio of every call, live, as it happens — that is the transcription
> service your key connects to, and it is how your words become text at all.
>
> **Your AI provider** receives the transcript whenever a feature reads a call: summaries, coaching,
> task extraction, live cues and Sales Brain. Turning a feature off is what stops it.
>
> **Your CallRise backup** receives your tasks, calendar events, and each call's title, summary and
> coaching scores while you're signed in — plus whatever you switch on below.
>
> All of it is also kept on this device.

**Draft — the short version, if three named services on the first card is too much:**

> Your calls are kept on this device, and they also reach two services you connected: Deepgram
> transcribes the audio of every call, and your AI provider receives the transcript whenever a
> feature reads a call. What goes to your CallRise backup is below — along with your tasks, calendar
> events and each call's title, summary and coaching scores, which sync whenever you're signed in.

I prefer the long one. This is the page a person opens *because* they want the detail, and the short
version's "two services you connected" is the compression that reads fine until someone asks which
two.

**The nav description**, at `settings-nav.ts:270` and again at `:492`:

> current: What stays on this device, and what backs up to your account.
> draft:   What backs up to your account, and where else your calls go.

The current one is the two-box framing in its purest form, and it is the first thing a user reads
about this page.

---

# 5. What I am not proposing

- **No new gate.** Nothing here adds a control. BUG-223 settled that, and the Deepgram row is the
  clearest case for it: a switch that stops the audio reaching the transcription service is a switch
  that stops the product.
- **No pattern added to the locality guard for the recordings finding.** A label naming a category
  that does not exist is not something a regex over sentences can catch, and adding one would imply
  coverage the measurement does not support.
- **No rewrite of the approved Sales Brain card.** It survived this pass unchanged.

---

# 6. Decisions

1. **The Deepgram sentence** — the wording, and whether it goes in all three places or fewer.
2. **The opening card** — long, short, or your own words.
3. **The nav description** — as drafted, or leave it.
4. **The five renames**, toggle label included. A label change on a privacy toggle is yours.
5. **The other four rewrites** (A, B, E, and the CoachingView pair in F).
6. **Withdraw F and G**, with their reasons written into `ACCOUNTED_FOR`, and add the `because`
   field.

Done as ordinary work, not needing a decision: three comments in `calls-fs.ts` (`:1303`, `:1304`,
`:1413`, `:1544`) said the preview, the transcript and an attachment's AI summary "never leave the
device", beside the fields they exclude from the backup payload — one of them in the same sentence as
the Claude API call that produces it. Fixed in `e81eff1`.
