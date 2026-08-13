# M25 Sales Brain — manual QA checklist

There's no AI-mocking precedent in this codebase for a controllable multi-call
simulator run of Sales Brain's judgment layer (see the longitudinal test
suite's own header comment on why), so unlike M22/M24 there's no
`npm run simulate:call` pass here. Instead: a store-layer longitudinal test
covers the deterministic engine automatically (run as part of `npx vitest
run`), and this checklist is entirely real-app, real-call verification. Check
off each item; anything that fails goes back with the exact repro.

## 0. Setup

- [ ] `npm run build` succeeds with zero errors.
- [ ] `npm run typecheck` — zero errors.
- [ ] `npx vitest run` — full suite green, including
      `src/main/memory/__tests__/*` and `src/main/coaching/__tests__/skill-graph.test.ts`.
- [ ] Fresh profile: Settings → **Sales Brain (Beta)** is visible and **OFF**
      by default.
- [ ] With it OFF, confirm no `memory.db` file gets created in the app's data
      folder even after using the app normally (making calls, opening chat) —
      the master flag must keep the whole module completely inert.

## 0.5. Startup never blocks login (regression check — see the post-ship incident in M25-sales-brain.md)

v1.1.9 briefly locked real users out of login because Sales Brain's init could stall startup before auth's IPC handler registered. v1.1.10 fixed the ordering. Test the exact failure mode directly, not just "does it work normally":

- [ ] On a profile with Sales Brain **ON** and the local embeddings model **not yet cached** (delete `<userData>/memory-model-cache` first, or use a genuinely fresh profile), launch the packaged app and confirm the login screen becomes usable immediately — it must never show "Accounts aren't set up" while Sales Brain is still initializing in the background.
- [ ] While that first-ever embeddings download is still in progress (check the app's startup/error log, or just time it), confirm you can still log in, view calls, and use every non-Sales-Brain feature normally.
- [ ] Force a Sales Brain init failure (e.g., temporarily rename `memory.db` to something invalid mid-migration, or block network access before the embeddings model has ever been downloaded) and confirm the rest of the app — login very much included — still starts up normally, with Sales Brain simply staying inert for that session.

## 1. Turning it on + onboarding interview

- [ ] Toggling Sales Brain on for the first time launches the onboarding
      interview automatically.
- [ ] Each of the 5 fixed questions (product/pricing, ICP, top objection,
      goals, communication style) can be answered, and each answer is saved
      immediately as a confirmed fact (not a hunch) — verify in Memory Center
      afterward.
- [ ] "Skip this question" moves to the next one without saving anything for
      that topic; "Skip setup entirely" exits the interview cleanly.
- [ ] Re-running the interview later (Settings) works and doesn't duplicate
      already-answered topics awkwardly.
- [ ] `memory.db` now exists in the app's data folder, confirming the DB is
      only ever created once the feature is actually turned on.

## 2. Migration safety (do this on a real, already-populated profile)

- [ ] With Sales Brain already on and holding real memories, simulate an
      app update by bumping the app's version and confirm on next launch the
      DB opens normally with no data loss (the automated migration-drill test
      already proves the code path — this is a real end-to-end sanity check
      on your machine, not a repeat of that test).
- [ ] Confirm a pre-migration backup file appears next to `memory.db` during
      an actual version bump that includes a real schema change.

## 3. Extraction from a real call

- [ ] Have a real (or simulated via a second device) call where you say
      something that fits an allowed category (e.g. state a clear objection
      pattern, mention your pricing model, or say something durable about the
      person you're talking to).
- [ ] After the call ends, confirm the "Sales Brain learned something"
      notification appears (only when something new was actually extracted —
      confirm it does NOT appear on a call where nothing new came up).
- [ ] Click the notification — the review screen opens, focuses the app, and
      shows exactly what was learned from that call, matching what you
      actually said.
- [ ] Dismiss one of the reviewed items and confirm it's gone from Memory
      Center afterward.
- [ ] Deliberately say something personal/emotional/health-related on a call
      (e.g. "I've been stressed about my kid's school") and confirm it is
      **never** extracted, no matter how it's phrased — this is the hard
      guardrail, verify it directly rather than trusting the prompt.
- [ ] A single passing mention of something should surface as a hypothesis
      (not yet trusted) in Memory Center — confirm the status badge reads
      correctly.
- [ ] Say the same kind of thing on 3 separate calls and confirm the fact
      promotes from hypothesis to a trusted/active status only after the
      third one (not the first or second).

## 4. Consolidation

- [ ] Say something that directly contradicts an existing confirmed memory
      (e.g. previously said "prefers email," now say "actually just text
      me") and confirm the old fact becomes invalidated (not deleted — check
      the changelog still shows it) while the new one becomes the active one.
- [ ] Say the same fact a slightly different way and confirm it reinforces
      the existing memory instead of creating a near-duplicate.

## 5. "Don't learn from this call"

- [ ] On a call's detail page, toggle "Sales Brain won't learn from this
      call" and confirm any memories already tied to that specific call
      disappear from Memory Center immediately.
- [ ] With the toggle on, confirm no new "learned something" notification
      ever fires for that call, even if you re-process it.

## 6. Memory Center

- [ ] Scope tabs (About you / Your business / Per client) correctly filter
      the list.
- [ ] Editing a memory's statement saves it, re-embeds it (no crash), and
      bumps its status to confirmed/active even if it was a hypothesis
      before.
- [ ] Pinning a memory shows the pin indicator; pinned memories are excluded
      from the "forget everything" and decay flows (see below).
- [ ] Deleting a memory removes it permanently — confirm it does not
      reappear after restarting the app.
- [ ] The changelog view shows created/confirmed/invalidated timestamps that
      match what you actually did in this session.
- [ ] The "N new things learned this week" count matches what was actually
      learned since Monday (or however the window is defined) — spot-check
      the math, don't just trust it renders.
- [ ] "Forget everything" (after confirming) wipes every memory across every
      scope — confirm Memory Center is empty afterward and every AI surface
      below (section 7) degrades gracefully with no memory context.

## 7. Surface integrations — confirm the profile is actually being used

- [ ] **Live cues**: with real accumulated rep-scope memory, confirm a live
      cue during a call reflects something from that memory (not just
      generic advice) at least once — and confirm cue latency isn't
      noticeably worse with Sales Brain on (profiles are precompiled, so it
      should be instant).
- [ ] **Coaching report**: confirm the report references your Sales
      Brain profile (e.g. a personal talk-ratio benchmark, once you have 5+
      past calls of the same type) rather than only population defaults.
- [ ] **Prep brief**: for an event linked to a contact with client-scope
      memory, confirm the "Your edge (Sales Brain)" card appears with real,
      relevant content; for an event with no linked contact, confirm the
      brief still generates normally with no error.
- [ ] **CRM note generator**: confirm a generated note reflects business-scope
      memory (e.g. correct terminology/pricing language) where relevant.
- [ ] **Coaching chat**: ask a question like "what do you know about how I
      handle pricing objections?" and confirm the answer is actually
      specific to memories on that topic, not a generic response. Confirm a
      "Save to Sales Brain" chip appears when you state something new, and
      that clicking it saves the memory as immediately confirmed.

## 8. Backfill

- [ ] From Settings, run "Import your past history" with **only**
      contacts/deals included (calls unchecked) — confirm it completes
      quickly, with no AI cost, and Memory Center shows new client-scope
      facts (industry, budget, timeline, etc.) sourced from your existing
      contact/deal records.
- [ ] Re-run with "include past calls" checked — confirm progress updates
      visibly, it completes without aborting on any single failed call, and
      new memories appear extracted from historical transcripts.
- [ ] Confirm free-text fields (personal notes, briefing notes) are **not**
      pulled into memory verbatim during backfill — only the structured
      fields listed in the docs.

## 9. Cloud backup (if enabled)

- [ ] With Settings → Backup → Sales Brain sync turned on, confirm a backup
      run uploads `memory.db` as a single file (check Supabase Storage
      directly if you have access) rather than syncing per-row.
- [ ] Confirm a restore on a genuinely fresh machine/profile downloads and
      seeds `memory.db` correctly.
- [ ] Confirm a restore on a machine that **already has** a local
      `memory.db` does **not** overwrite it — this path is seed-only, by
      design.
- [ ] Note: this requires `supabase/2026-08-sales-brain-backup.sql` to have
      already been run manually against the real Supabase project — confirm
      that's been done before testing this section, otherwise expect it to
      fail outright.

## 10. Regression check — existing features untouched

- [ ] Every M22/M23 feature (Coach 2.0, coaching chat's non-memory
      behavior, CRM notes, Contact Intelligence) still works exactly as
      before with Sales Brain OFF.
- [ ] Turning Sales Brain OFF after it was on leaves all other features
      working normally (no leftover errors referencing a missing DB).
- [ ] Consent architecture (M11) is untouched — a call with the other party
      not consented still produces zero memories from their side of the
      conversation, and a fully consent-blocked call produces zero memories
      at all.

## 11. Cross-platform

- [ ] **Windows**: full pass above, on both dev build and a real packaged
      build (`electron-builder --win portable`), not dev mode only —
      sqlite-vec and better-sqlite3 are native modules and dev-mode-only
      testing has hidden packaging bugs before in this app.
- [ ] **macOS**: not run in this environment (no Mac available). Nothing in
      the design is platform-specific beyond the same native-module
      packaging every other native dependency in this app already needs, but
      this is a real, unverified gap — needs a full pass through this
      checklist on real Mac hardware before Sales Brain is considered fully
      cross-platform verified.
