# Round five — the copy, against the tree as it stands

**2026-09-08. Nothing here is committed. Every string is yours to approve, reject or rewrite.**

The four things you said to wait for have landed: BUG-224's reflection disclosure (`bb0191f`), the
scope line above the toggles (`ff13971`), BUG-219 settled as fix-the-sentence, BUG-221 fixed
(`9f327a1`). So behaviour has stopped moving and this round is written against it.

**How this was derived.** I read the code for every claim below rather than taking any of it from the
earlier rounds, the pending list, or a review. Where I contradict something this project has already
recorded — and I do, twice — the file and line is there so you can check me rather than take it.

---

## 1. The finding: there are three destinations, and the product has never named the first one

Everything through four rounds has been written as if there were two places data can go: this device,
and your CallRise backup. That framing is in the page's own nav description, in the notice card at
the top of it, and in every sentence that failed.

There are three.

| destination | what reaches it | what a user can do about it |
|---|---|---|
| **Deepgram** | the raw microphone audio of **every call**, streamed live as it happens (`transcription.ts:487` sends the PCM frames to `wss://api.deepgram.com/v1/listen`) | nothing. There is no toggle. It is how the words appear at all |
| **your AI provider** | the verbatim transcript, whenever a feature reads a call — summary, coaching, task extraction, live cues, Sales Brain extraction — plus the derived facts once a night (BUG-224) | turn the feature off |
| **your CallRise backup** | tasks, calendar events, and every call's title, summary and quote-free coaching, always, while signed in (`backup.ts:1016-1018`); plus the seven categories you switch on | the toggles, and signing out |

The first row is the one nothing in the product mentions. Not on the privacy page, not in the AI
provider card, nowhere. **It is also the only one with no control at all** — every other destination
has a switch somewhere, and this one is the price of the product working.

I do not think that is a bug in the behaviour. A transcription product transcribes, and the user
connected that service with their own key. But four rounds of copy have now failed partly because
they were dividing the world into two boxes when there are three, and the missing box is the one
carrying the raw audio.

---

## 2. The word "recordings" describes something that does not exist

**The app never writes a call recording to disk, and no recording is ever uploaded.**

- No audio path in either backup payload: `callBackupPayload` (`calls-fs.ts:1296`) and
  `callFullBackupPayload` (`calls-fs.ts:1352`) carry metadata, summary, coaching, segments,
  bookmarks. No audio, no file reference.
- No audio in the storage buckets: `attachments` uploads `call.attachments` only
  (`backup.ts:719-724`); `sales-brain` uploads `memory.db`.
- Nothing writes call audio to disk at all. A tree-wide search for `MediaRecorder`, `.webm`, `.wav`,
  `recordingsDir`, `saveRecording` finds exactly two audio writers, and neither is a call: the mic
  test (played back and discarded) and Rise voice notes (`assistant-ipc.ts:894`).

Five user-facing strings say "recordings" anyway:

    BackupCard.tsx:109   toggle label   "Call recordings & transcripts"
    BackupCard.tsx:351   sync-on banner "Call recordings & transcripts sync is ON"
    BackupCard.tsx:414   footer, on     "Call recordings and transcripts sync too"
    BackupCard.tsx:415   footer, off    "...never leave this computer unless you turn that on"
    PrivacyNoticeCard.tsx:9             "Your call recordings, transcripts, ... live only on this device"

**It is wrong in both directions at once, which is why it is worth its own item.** The toggle
promises an upload that never happens — a user who switches it on believing their call audio is
protected on a new machine is wrong, and would only find out by losing the machine. And the off-state
sentence promises the audio stays here, while it is streaming to Deepgram during every call.

**No guard could have caught this**, and I want to say why rather than add one and imply it is
covered. The locality test sweeps for sentences that make a claim. `label: 'Call recordings &
transcripts'` is not a claim — it is a noun. The falseness is that the noun names nothing. The only
instrument for that is someone asking "does this category exist?", which is the same instrument that
found it.

**Proposed: drop the word from all five sites.** The toggle becomes **"Call transcripts"**. That is
what it governs.

---

## 3. The seven pinned sites — five stand, two do not

The pending list has no `because` field. `ACCOUNTED_FOR` requires a written argument for every entry;
`PENDING_FOUNDER_APPROVAL` requires none. I checked all seven against the code, and **two of them are
true as written.** They were pinned by a sweep, and no one has had to defend them since.

That asymmetry is worth fixing on its own: the list of things we claim are FINE carries an argument,
and the list of things we claim are LIES carries nothing. An unargued accusation rots the same way an
unargued exemption does — and one of these has been sitting on a to-fix list generating the
impression of debt that is not there.

### Still false — five, with drafts

**A. `home/activationSteps.ts:167`** — *"Runs entirely on your own device."*

False three ways: extraction sends the transcript to the AI provider, reflection sends the facts
nightly, and `memory.db` uploads to the `sales-brain` bucket when both toggles are on.

> Sales Brain remembers who you are, how you sell, and each client — so summaries and coaching stop
> starting from scratch every time. Facts are extracted through your own AI provider.

*(The locality sentence is removed rather than replaced. An activation step is one line; the full
account is on the card it links to, which you have already approved.)*

**B. `settings/MemoryCenterSection.tsx:375`** — *"Runs entirely on your own device. Nothing is sent
anywhere."*

This is the `cost` line of an off-state — the sentence whose whole job is to tell someone what
turning it on will cost them. It currently tells them it costs nothing, and what it actually costs is
the thing they might care most about.

> Uses your own AI provider: it reads your calls to extract facts, and reviews those facts once a
> night.

**C. `settings/PrivacyNoticeCard.tsx:9`** — *"Your call recordings, transcripts, knowledge base, and
app settings live only on this device."* — the opening card. Drafted in full in §4.

**D. `backup/BackupCard.tsx:415`** — *"Your call recordings and transcripts never leave this computer
unless you turn that on above."*

> **off:** Your transcripts are not included unless you turn that on above. Your AI provider still
> receives them whenever a feature reads a call.
>
> **on:** Your transcripts sync too, since you turned that on above.

And `:351`, dropping the same word:

> Call transcripts sync is ON — your buyer conversations are stored in your cloud account, not just
> this device.

**E. `settings/TelemetrySection.tsx:260`** — *"Nothing has been sent from this computer."*

Two problems. It is scoped by its surroundings to diagnostics but worded absolutely, on a privacy
screen, for a user who is signed in and syncing. And it is false in its own scope: the log is
user-deletable (`sent-log.ts`, and the Delete button at `:279`), so pressing Delete makes the app say
nothing was ever sent.

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
and your existing coaching contributes nothing. The dashboard stays empty until you coach a new call.
"Scores every coached call" in the line above has the same problem.

> **what:** Scores each call you coach against eight named selling skills and charts how each one
> moves over time, so you can see which is actually improving and pick one to work on. Scoring
> starts from your next coached call.
>
> **cost:** No extra AI calls — the scores come from coaching you were already running.

This is the one I would take from this round even if you take nothing else, because it is the shape
we keep finding: **the sweep pinned the clause it had a pattern for, and the false clause beside it
went unread for the same reason it was written — nobody was checking that half.**

**G. `home/AccountMigrationNoticeCard.tsx:63`** — *"Your calls, transcripts, contacts and Sales Brain
live on this computer and are completely unaffected."*

True as written. It says the data lives on this computer, which it does; it does not say *only*. And
"completely unaffected" is a claim about the Supabase project switch, which touches nothing local.
The guard matched it because the pattern `on (this|your) (computer|...)` is deliberately wide and the
sentence wraps across two lines — a true positive for the net, a false one for the finding.

**Proposed: move both to `ACCOUNTED_FOR` with those reasons, and give
`PENDING_FOUNDER_APPROVAL` a `because` field so the next entry has to be argued.** The count guard
changes from 7 to 5 and stays red in both directions.

---

## 4. The opening card, and the page heading you held for this round

`PrivacyNoticeCard` is the first thing on Privacy & data, and its own doc comment calls it "a short,
honest recap". It is the sentence that has to carry the three destinations, because every card below
it is about one of them.

**Draft — the long version, which I recommend:**

> **Where your call data goes.**
>
> **Deepgram** receives the audio of every call, live, as it happens — that is the transcription
> service you connected, and it is how the words appear at all.
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
version's "two services you connected" is the kind of compression that reads fine until someone asks
which two.

**The nav description**, at `settings-nav.ts:270` and again at `:492` — you asked me to leave it
until this card landed:

> current: What stays on this device, and what backs up to your account.
> draft:   What backs up to your account, and where else your calls go.

The current one is the two-box framing in its purest form, and it is the first thing a user reads
about this page.

---

## 5. What I am not proposing

- **No new gate.** Nothing here adds a control. BUG-223 settled that, and the Deepgram row is the
  clearest case for it: a switch that stops the audio reaching the transcription service is a switch
  that stops the product.
- **No pattern added to the locality guard for the recordings finding.** A label naming a category
  that does not exist is not something a regex over sentences can catch, and adding one would imply
  coverage the measurement does not support — round 2 of that measurement caught 0 of 5 and is
  deliberately still not in the list.
- **No rewrite of the approved Sales Brain card.** It survived this pass unchanged.

---

## 6. Decisions

1. **The opening card** — long, short, or your own words.
2. **The nav description** — as drafted, or leave it.
3. **"Call recordings" → "Call transcripts"** across five sites. This is a *label* change on a
   privacy toggle, so it is yours, not mine.
4. **The five rewrites** (A, B, D, E, and the CoachingView pair in F).
5. **Withdraw F and G from the pending list**, with their reasons written into `ACCOUNTED_FOR`, and
   add a `because` field to the pending list so the next pin has to be argued.

Separately, and not needing a decision: two comments in `calls-fs.ts` (`:1303`, `:1304`) say the
preview and the transcript "never leave the device", beside the fields they exclude from the backup
payload. What they mean is "never enter this payload"; what they say is the thing that is false, in
the permission-granting position you named last round. I am fixing those as ordinary work, since
they are comments rather than copy.
