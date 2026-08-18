# M25 — Sales Brain: architecture, in plain language

This doc explains what Sales Brain is and how it's built, for a non-technical reader. It's written incrementally as each phase lands — this version covers **Phase 1** (the foundation: storage, migrations, embeddings, extraction), **Phase 2** (the consolidation engine: merging, contradictions, promoting hypotheses to real facts, forgetting over time, and the compiled profile), **Phase 3** (actually using all of that in the rest of the app), and **Phase 4** (coaching chat gets full read/write access to it, plus the first-run interview). Later phases will add their own sections rather than rewriting this one.

## The idea, in one sentence

Every AI feature in CallRise today is smart about *the call* but forgets everything the moment it ends. Sales Brain gives the app real, persistent memory — the kind ChatGPT has — so it learns who you are, how you sell, what your business is, and what's true about each client, and every other feature (live cues, coaching, chat, briefs) gets smarter from it over time.

## The privacy promise, and how the code actually keeps it

**"Your sales brain never leaves your device."** Concretely, that means two things, both true as of Phase 1:

1. **Every memory is computed and stored locally.** There's a small AI model (~23MB) that runs entirely on your own computer to turn a sentence like "the rep talks fast when nervous" into a list of 384 numbers (an "embedding") that captures its meaning, so similar facts can be found later without needing to re-read every memory with an AI call. This model never sends your data anywhere — it's the same kind of local computation as spell-check. The **one and only** network request in this whole pipeline is downloading that model's file itself, once, the very first time you use the feature — that's downloading the *model*, never uploading *your* data.
2. **Extracted facts still go through your own configured AI provider** (whichever one you've connected — Anthropic, OpenAI, Groq, etc.) to actually read a call transcript and decide what's worth remembering. That's unavoidable — something has to read the transcript to find the facts — but it's the exact same kind of AI call every other feature in this app already makes (coaching, summaries), through the exact same "bring your own key" system, nothing new or different.

## What actually gets remembered — and what never does

Every extracted memory has to fit one of a small, fixed list of categories: things about how you sell (patterns, strengths, struggles, goals, preferences), things about your business (pricing, product, competitors, common objections), or durable facts about a specific client. That list is enforced in code, not just in the AI's instructions — if the AI tries to return anything outside that list, it's silently dropped before it ever reaches storage.

**Explicitly, permanently off-limits:** anything about mental or emotional state, health, family, or personal life — even if it comes up on a call. The extraction system is instructed to never touch this category, full stop, regardless of how "useful" it might seem.

**Every fact is checked before it's trusted.** The AI doesn't just get to assert something — it has to point to the exact sentence in the transcript that supports it, and the code independently verifies that sentence was actually said (not invented, not too short/vague to mean anything). This is the same anti-hallucination check already proven on the "who was I talking to?" feature — reused here from day one rather than learned the hard way a second time.

## Where the data actually lives

One new file, called `memory.db`, sitting in the same folder as everything else this app already stores on your computer (calls, contacts, tasks). It's a real, standard database format (SQLite) — the same technology used by a huge number of desktop and mobile apps — plus a small extension (`sqlite-vec`) that lets it search "which memories are *similar in meaning* to this one" quickly, without needing a server anywhere.

This is a genuinely new kind of file for this app. Every other thing you've seen this app store (a call, a contact, a task) is just a plain text file. `memory.db` is the first real database — which is exactly why the next section (migrations) matters so much: a plain text file is forgiving if something's slightly off; a database is much less so, which is why extra care went into making upgrades to it safe.

## Migrations — how the app safely upgrades this file over time, explained plainly

Every future update to this app might need to change the *shape* of `memory.db` — add a new column, a new table, something like that. That's called a "migration." Here's exactly what happens, in order, every single time the app starts:

1. **The app checks a number stamped inside the file itself.** SQLite has a built-in slot for exactly this — no custom bookkeeping needed. If that number matches what this version of the app expects, nothing happens; the app just opens the file and moves on. This is the normal case, essentially instant.

2. **If the file's number is *older*** (this file was created by an earlier version of the app and needs upgrading): before touching a single row, the **entire file gets backed up** — a real, consistent snapshot (using SQLite's own built-in backup mechanism, not just a raw copy, so it can never be caught mid-write). Only *after* that backup exists does the actual upgrade run, and it runs as **one single all-or-nothing step** — either every part of the upgrade succeeds together, or none of it takes effect at all. That's not a design choice I'm hoping holds up; it's a real guarantee SQLite's transactions provide.

3. **If anything at all goes wrong during the upgrade:** two independent safety nets catch it. First, the failed step is automatically undone by the database itself. Second — as a completely separate backstop, in case the first one somehow didn't work — the pre-upgrade backup gets restored on top of it. I tested this exact failure path directly (not just reasoned about it): I deliberately broke a migration, ran it against a database that had real data in it, confirmed the app reported the failure cleanly, and then confirmed — by reopening the actual file from scratch — that the data was completely untouched and the file was still on the old (working) version. That test is part of the permanent test suite now, so it keeps getting checked automatically on every future change.

4. **If the file's number is *newer* than what the app expects** (meaning some future version of the app already upgraded it, and you're now somehow on an older version — very unlikely given auto-update, but not impossible): the app refuses to touch the file at all rather than guess. Sales Brain just goes quiet until you're back on a current version. This is much safer than attempting to "downgrade" a database, which nothing in this app tries to support.

**In every single one of these cases, none of your calls, contacts, or anything else this app already stored is ever at risk** — this whole process only ever touches the one separate `memory.db` file.

## Backup to the cloud — the decision, and why

Your existing cloud backup system (the one that saves your calls/contacts/tasks to your account so you can restore them on a new computer) works record-by-record — every call, every contact is its own row, and if you use the app on two computers, changes merge together sensibly.

`memory.db` doesn't fit that pattern easily — it's one single database file, not a list of separate records the cloud system already understands. Two ways to handle it:

- **(a) Upload the whole file as one blob** (the same simple approach already used for attached documents like PDFs) — whenever the app backs up, it just uploads the entire `memory.db` file as-is.
- **(b) Break memories into individual cloud rows**, like every other record type — more correct if you ever use the app on two different computers at once, since it would merge properly instead of one computer's file silently overwriting the other's.

**Decision: (a), the simple blob upload.** This matches the actual situation today — Sales Brain is single-machine, Windows-only, and "local-first, cloud is disaster recovery" is the real invariant behind this whole feature, not just a nice-to-have. Cloud backup for `memory.db` is also **off by default**, same as every other optional backup category in this app (you have to explicitly turn it on in Settings → Privacy & data) — matching the same "local-first, opt-in for cloud" spirit as the feature itself.

**If multi-device support is ever built, option (b) — real per-record sync — is the known, deliberate upgrade path.** This isn't a corner that got cut without noticing; it's flagged directly in the code (`app-settings.ts`'s `BackupSyncScope.salesBrain` field, and the SQL file that sets up the cloud storage bucket) so a future me — or you — reading that code later understands exactly why it's simple today and what "better" looks like when it's actually needed.

One more safety detail: restoring `memory.db` from the cloud **only ever happens on a brand-new install with no local memory file yet.** If you already have a `memory.db` on a machine, the cloud copy is never pulled down on top of it — since there's no per-record merging yet, downloading over an existing file could silently lose memories that were only ever saved locally. A fresh machine gets the cloud copy once; after that, your local file always wins until real multi-device merging exists.

## What was actually tested before calling Phase 1 done

- **The migration system**, including the real failure/rollback path described above — not just the happy path.
- **The AI-hallucination guardrails** on extracted facts — bare/lazy quotes, ungrounded quotes, category mix-ups, and a client-scoped fact with no real client to attach it to are all independently tested and confirmed rejected.
- **The full existing app test suite** (1,143 tests) — confirming this milestone introduced zero regressions to anything that existed before it.
- ~~**The actual packaged Windows build** — not the developer version. The two native components this feature depends on (the real SQLite engine, and its vector-search extension) were proven to load and run correctly from inside a real packaged build of the app, doing a real similarity search over real (if synthetic-for-the-test) data, with the correct nearest match found every time. This app has been bitten twice before by a native component that worked in development but silently broke once packaged for real users — this test exists specifically because of that history, not as a formality.~~

> ⚠️ **CORRECTION (M27 Phase 4 docs audit, 2026-08-14) — the struck-through claim did not hold, and the exact failure it promised to prevent is the one that happened.**
>
> Sales Brain shipped **completely dead in every packaged build** in v1.2.0, taking **four patch releases** to fully fix:
> - **1.2.1** — `initSalesBrain()` could throw synchronously on a native-module load failure and nothing retried, so "not ready yet" silently became "nothing ever happens" (see `memory-runtime.ts`'s `ensureMemoryDb` comment).
> - **1.2.3** — `onnxruntime-node` (the local-embeddings backend) statically imports `MSVCP140.dll` / `VCRUNTIME140.dll` / `VCRUNTIME140_1.dll`. Present on any machine with Visual Studio — every dev box **and** every CI runner — absent on a clean Windows install, where the load fails with `ERROR_MOD_NOT_FOUND`, surfaced as the bare OS string *"The specified module could not be found."*
> - **1.2.4** — `sqlite-vec` resolves `vec0.dll` via `require.resolve`, which inside a packaged app points **into `app.asar`**, where the Win32 loader cannot open it (`6e8c70d`, "Fix Sales Brain dead in EVERY packaged build: vec0.dll asar path"). That is precisely the "vector-search extension proven to load from inside a real packaged build" the text above claimed.
>
> **The lesson, now a standing unconditional item in the vault's release checklist:** the packaged-build test that ran *did* execute — on a developer machine, which structurally cannot falsify this class of bug, because it already has every dependency the clean machine is missing. "Tested the packaged build" and "tested the packaged build on a machine that has never had Visual Studio or Node.js" are different claims, and only the second was ever worth anything here. The original framing — *"this test exists specifically because of that history, not as a formality"* — was itself the trap: it felt rigorous, so nobody asked what it could not see.

## What Phase 1 does NOT do yet (now built in later phases, unless noted)

- ~~Nothing is visible in the app.~~ **A real Settings toggle exists now (Phase 4)**, plus the pre-call brief's "Your edge" section (Phase 3). The full Memory Center browse-everything screen is still Phase 5.
- ~~No "3+ calls makes it a real fact" promotion, no contradiction handling, no forgetting over time.~~ **Built in Phase 2.**
- ~~Nothing is injected into live cues, coaching reports, or chat yet.~~ **All three now use it — live cues and coaching reports since Phase 3, coaching chat (full profile + live retrieval + save chips) since Phase 4.**

## Phase 2 — the consolidation engine, in plain language

Phase 1 could extract candidate facts from a call. It had no opinion about whether a fact was actually *true and settled*, whether two facts said the same thing in different words, whether a new fact contradicted an old one, or whether a fact nobody's mentioned in months should still be treated as current. That's what Phase 2 adds — the part of the system that turns "the AI noticed this once" into "this is something we actually know."

**Merging duplicates.** If the exact same fact gets restated, it's recognized instantly, no AI needed — that's a plain text match. But people rarely say the same thing the same way twice ("talks fast when nervous" vs. "speeds up under pressure"), so for anything *close* in meaning (found using the same "similarity search" from Phase 1), the AI is asked one direct question: are these really the same fact? Only if it says yes do they get merged into one, stronger memory instead of sitting as two separate, weaker ones. If the AI call fails for any reason, the safe default is "treat them as different" — better to have two overlapping memories sitting around a bit longer than to wrongly merge two things that were actually different.

**Handling contradictions.** If a new fact directly conflicts with something already trusted ("prefers email" vs. a later "prefers Slack"), the AI is asked to confirm the conflict is real, not just a difference in phrasing. If confirmed, the *old* fact is never deleted — it's marked as replaced, with a link pointing forward to whichever new fact replaced it. The full history stays visible; nothing quietly vanishes.

**Promoting a hunch into a real fact.** A pattern noticed on a single call is just that — a hunch, never asserted as established. Only once the *same* pattern has been independently observed across three genuinely separate calls does it get promoted to a trusted, "active" fact the rest of the app is allowed to actually rely on and state as true. (Something you directly tell the coach yourself, and confirm, skips this — you don't need to repeat yourself three times for the app to believe you.)

**Reflection — finding patterns you never said outright.** Once a night (practically: the first time you open the app each day, since this app doesn't run in the background 24/7 — there's no real "while you sleep" moment to hook into, so "roughly once a day, whenever you're next actually using it" is the honest, working substitute), the app looks across everything it currently trusts about you and asks: is there a *higher-order* pattern here that no single fact states on its own? For example, noticing that two *separate*, already-confirmed facts point to the same underlying tendency. This is the most speculative part of the whole system, so it's held to the highest bar: a suggested pattern is thrown out completely unless it can point to at least two specific, already-confirmed facts that genuinely support it — and this isn't just an instruction given to the AI, the code itself checks and rejects anything that doesn't meet that bar before it's ever saved. Even when it passes, it's saved as a tentative hunch, capped at a low confidence — never treated as an established fact on its own say-so.

**Forgetting, gradually, when nobody confirms something anymore.** A fact that goes unconfirmed for a long time slowly loses confidence — noticed once two weeks ago and never again since is treated very differently from something confirmed across ten calls. A fact you've directly told the app, or pinned yourself, never fades this way — that's a deliberate floor, not an oversight. Everything else can, over time, quietly step back down from "trusted fact" to "hunch," and eventually to "no longer surfaced at all" if it's been long enough with nothing reconfirming it. Nothing is ever deleted outright — it just stops being asserted.

**The compiled profile.** At the end of every one of these passes, a short summary gets rebuilt — the actual text that will eventually get fed into live cues, coaching reports, and chat (that wiring itself is Phase 3/4). Three sizes are kept ready at all times — a tiny one for anything that needs to stay instant (live, in-call cues), a medium one, and a larger one for coaching chat, which can afford more context. Building these ahead of time, rather than in the moment they're needed, is what makes it possible to use them later with zero added delay.

**What was tested:** every deterministic piece above — the 3-calls-before-trusted rule, the "pinned/user-confirmed facts never fade" floor, the forgetting math itself, and the profile-building logic — has its own automated test proving the exact behavior described here, not just a description of intent. The parts that call an AI to make a judgment call (is this the same fact? does this contradict? is this pattern real?) are reviewed carefully but aren't independently AI-tested the same way, matching how the rest of this app already treats AI-judgment code — same standard as everywhere else, not a lower bar for this being new.

## Phase 3 — putting the profile to work, in plain language

Phase 1 and 2 built the memory itself. Phase 3 is where it actually starts changing what you see. Every place below reads an already-built profile straight out of the database — never a live AI call just to fetch it — so none of this slows anything down, even the parts that already had to be instant.

**Live, in-call cues.** The very short profile (the "micro" one, built to stay tiny on purpose) is now included every time the app decides whether to show you a coaching cue mid-call. This is the one place speed matters most, and reading an already-built profile out of the database takes a fraction of a millisecond — there's no way for this to be the thing that makes a cue late.

**Coaching reports.** The medium-sized profile is now included when a call gets scored — the same "know who they're talking to" idea, just for the after-the-call report instead of the live one.

**Your personal norms vs. the general research.** This is a different piece of memory than the "facts about you" kind: this one is straight statistics from your own call history, no AI extraction involved. Today, Coach 2.0 always compares your talk-ratio and question-count against general sales research averages. Once you have enough of your own coached calls of the same type (5+), the app starts comparing you against **your own** typical range instead where that make sense — the actual scoring math doesn't change, only what "on target" means for you specifically. Until you have that much history, nothing changes at all; you'd see identical scores with or without this turned on.

**The pre-call brief gets a new section.** This is the one part of Phase 3 you can actually SEE without needing to open developer tools: a new "Your edge" card on the prep brief, showing what's known about the specific person you're about to talk to, plus your business's own proven responses to likely objections — whenever there's enough built up to show.

**CRM notes.** When a note gets auto-drafted for a contact, it's now written with awareness of your actual business context (your real terminology, your ideal customer profile) instead of generic phrasing.

**The one hard rule that held throughout:** every single one of these only ever reads memories that have graduated to "trusted fact" status (Phase 2's promotion rule) — never a still-unconfirmed hunch, and never something that's been contradicted or forgotten. If Sales Brain is off, or you simply don't have enough history yet for a given piece, every one of these sections is silently absent — not a placeholder, not an empty box, just genuinely not there, identical to how the app looked before this milestone.

## Phase 4 — coaching chat gets full memory access, and the first-run interview

**Ask your coach what it knows about you.** Coaching chat now gets the LARGEST profile size (it can afford the most context of anywhere in the app) — rep, business, and this specific client, all at once. On top of that, every question you ask triggers a fresh, targeted search specifically for whatever's relevant to THAT question — so "what do you know about how I handle pricing objections?" surfaces pricing-objection memories specifically, not just the same generic summary every time.

**"Save to Sales Brain" chips.** The existing "save this to the contact record" suggestion chips in chat (from M23) now have a sibling: when you say something worth remembering about yourself or your business, a "Save to Sales Brain" chip appears. Nothing saves until you tap it — same as every other suggestion chip already works. Anything saved this way is trusted immediately (you said it directly and confirmed it), not treated as a tentative hunch the way something auto-noticed from a call transcript is.

**The onboarding interview — and the piece that was actually missing before now.** Up through Phase 3, there was genuinely no way to turn Sales Brain on at all — the setting existed in the code, but no on/off switch existed anywhere you could actually click. That's fixed now: Settings → **Sales Brain (Beta)** is a real toggle. Turning it on for the first time offers a short interview — five fixed questions about your business, pricing, ideal customer, top objection, and what you're personally trying to improve — each answer turned into a handful of durable facts, saved as directly-confirmed (not a hunch) since you're stating them yourself. Skippable per-question or entirely, and re-runnable any time from that same Settings page if you want to answer differently later.

**What was NOT built, on purpose:** an AI-driven, fully open-ended interview that decides its own questions. Five fixed questions, asked in a fixed order, is far more predictable and reliable to build and test than an AI freestyling a conversation — and gets you the same outcome (seeded business-scope memory on day one) with much less risk of the interview itself going somewhere unhelpful.

## Phase 5 — a real place to see, edit, and control everything it's learned

Every phase before this one built the *engine*. Phase 5 is the part you actually interact with day to day.

**Memory Center.** A new Settings page lists every memory Sales Brain currently holds, grouped into "About you," "Your business," and "Per client." Each one shows the fact itself, how confident the app is in it, whether it's a confirmed fact or still just a hunch, and which category it fell under. You can edit the wording directly (editing something counts as you confirming it — it's immediately trusted, same as if you'd said it in chat), pin it so it never fades from disuse, or delete it outright. There's also a changelog view so you can see when things were learned or changed, and a simple weekly count ("N new things learned this week") so the feature doesn't feel invisible.

**Bring in what you already told the app.** This was the one thing added mid-milestone that wasn't in the original plan: a way to backfill Sales Brain from history you already have in the app, instead of starting from zero. From the same Settings page, an "Import your past history" action pulls durable facts straight out of your existing contacts and deals — industry, company size, budget, timeline, known objections, deal value, that kind of thing — instantly and for free, no AI involved, since those are already structured form fields, not something that needs to be extracted from freeform text. Separately, and off by default since it costs real AI calls, you can also opt in to running your **past calls** through the exact same extraction process a live call goes through today — so the same call from six months ago that would've taught Sales Brain something if the feature existed back then, still can.

**"Sales Brain learned something" after a call.** When a call teaches Sales Brain something new, you get a native notification — click it and a review screen shows exactly what was learned from that specific call, with a one-tap dismiss for anything you'd rather it forget. (Full editing of an already-saved memory lives in Memory Center, not this screen — this one's purely for a quick glance right after a call.)

**"Don't learn from this call."** Any individual call now has a toggle to exclude it from Sales Brain entirely. Turning it on doesn't just stop future learning from that call — it actively deletes any memories that were already pulled from it, so it leaves genuinely zero trace, not just a "won't happen again from here."

**"Forget everything."** A single button, with a confirmation step, that wipes the entire memory database — every fact, every scope, gone. This is the actual mechanical answer to "what if I just don't want this feature to have learned anything about me" — not a toggle you flip and hope, a real delete.

**What was scoped down, on purpose, given the time available:** the "don't learn from this call" toggle only works *after* a call ends (from the call's detail page) — there's no in-the-moment "don't learn from this one" switch you can flip while a call is actively being captured. The weekly digest is a simple count computed on the spot from timestamps, not a dedicated separate feature with its own history. The post-call review screen only supports dismissing a memory, not editing it inline (editing is a Memory Center thing). And the AI-judgment parts of consolidation — deciding two things are "the same fact," or that one fact contradicts another — are reviewed code, not independently AI-tested with a full mocked conversation, matching the standard already set for the rest of this engine rather than a new, higher bar.

**Testing.** Beyond the phase-by-phase unit tests (extraction, storage, consolidation, decay, migrations), there's now a dedicated longitudinal test that plays out a simulated 8-10-call sequence for one fake rep end to end: proving a pattern only gets promoted to a trusted fact after three separate calls mention it (never one or two), that a later contradiction correctly retires the old fact while keeping its history visible rather than deleting it, that a fact nobody reinforces for months quietly fades and archives, that a *pinned* fact survives that same fade, that a call marked "don't learn" contributes nothing at all even in the middle of the sequence, and that the compiled profile handed to other features never includes an unconfirmed hunch, only confirmed facts, no matter how many hunches pile up alongside them.

## Master flag

Everything in this milestone lives behind one setting: Settings → **Sales Brain (Beta)**, off by default. When it's off, nothing in this whole module runs — no database file gets created, no AI calls happen, nothing. As of Phase 4, this is a real, working toggle you can click yourself — not just a setting that exists in the code with no way to reach it.

## Post-ship incident: v1.1.9 briefly locked users out of login (fixed in v1.1.10)

Worth documenting plainly, since it was a real production incident, not a hypothetical risk this doc was hedging against.

**What happened:** `initSalesBrain()` was originally awaited right at the very top of app startup, before `registerAuth()` (and every other feature) had registered its IPC handlers. On a machine where Sales Brain's local embeddings model hadn't been downloaded yet, that first-use download could take long enough that the already-loaded login screen asked for auth status before the handler existed to answer it. The renderer's fallback for "no answer yet" happened to render identically to "Supabase isn't configured" — so affected users saw a false "Accounts aren't set up" screen and were genuinely locked out, even though their account and Supabase itself were completely fine.

**How it was found:** a real user reported being locked out on their main machine, then confirmed it independently on a second, unrelated machine — ruling out a one-off local glitch. Backend health was verified directly (Supabase's auth endpoints responded correctly, including a real token-grant request), which pointed the investigation away from the server and toward app startup ordering. Reproduced live by launching the actual published v1.1.9 build and watching one launch stall for ~48 seconds between "app ready" and "registrations done" in the startup log.

**The fix (v1.1.10):** `initSalesBrain()` now only blocks the three Sales-Brain-specific IPC handlers that genuinely need the database ready first (onboarding, backfill, Memory Center) — it runs *after* `registerAuth()` and everything else, not before. It's also wrapped in a 15-second timeout and a real try/catch, since the existing "never throws" doc comment on that function wasn't actually enforced in code.

**Why this matters beyond the one bug:** it's a reminder that "must run before X" ordering comments need to say *before which specific things*, not just "before registerX() calls" as a blanket statement — the original comment was accurate about the original narrow risk (memory data reachable mid-migration) but got read, in practice, as license to block the entire startup sequence on it.

## Known gaps, being upfront about them

- **Mac has not been verified.** This milestone was built and tested entirely on Windows — there's no Mac available in this environment. The code doesn't do anything platform-specific (no native modules beyond the same `better-sqlite3`/`sqlite-vec` stack that already gets built for both platforms elsewhere in this app), but "should work" is not the same as "confirmed," so treat Mac as untested until someone actually runs it there.
- **Backfill covers calls, contacts, and deals** — not the knowledge base, objection library, or any other structured data the app holds. That was a judgment call about which sources have clearly memory-shaped, extractable data versus which don't, made without an explicit follow-up confirmation — worth a second look if broader backfill ever matters.
- **Cloud backup is a whole-file upload/restore, not per-record sync.** That was the deliberate choice for this milestone (memory today is single-machine, Windows-only, and "local-first, cloud is disaster recovery" is the real invariant) — the known upgrade path if multi-device support is ever built is real per-row sync, not a redesign from scratch.
- **The Supabase bucket/policy migration for cloud backup (`supabase/2026-08-sales-brain-backup.sql`) has not been run against the real project yet** — it needs to be applied manually before the cloud-backup toggle will actually work end to end.
