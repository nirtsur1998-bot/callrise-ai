# M28 — Rise: architecture and decisions

Plain-language record of what was built and why. Companion to
`docs/M28-phase0-map.md` (the codebase map this was designed against).
Working name "Rise" — the display name lives in exactly ONE constant
(`src/renderer/src/features/assistant/config.ts`); every internal identifier
uses the neutral word `assistant`, so renaming the section is a one-line
change that touches no code identity.

## What Rise is

A top-level section (sidebar, above Live Calls) where the user talks to an AI
grounded in everything the app knows about them: Sales Brain profiles and
memories, past calls, contacts, deals, calendar. Chat first (this phase);
voice messages, live voice, and files come later phases.

## Phase 1 decisions (and the reasoning)

**1. Conversations are flat JSON files, not rows in memory.db.**
`userData/assistant-conversations/<id>.json`, mirroring the calls store:
atomic writes, one lock per conversation, sanitize-on-read. Reason: Rise must
work with Sales Brain OFF, and memory.db depends on native modules
(better-sqlite3/sqlite-vec) whose clean-machine failures caused the
1.2.1–1.2.4 hotfix run. Chat availability should not sit behind that failure
class. Conversations are local-only (not in cloud backup), same posture as
the per-call coaching chat.

**2. Main owns the in-flight turn; the screen is disposable.**
The M26 principle applied to streaming: deltas accumulate in the main
process, so navigating away mid-answer loses nothing — the screen re-attaches
on the way back (`assistant:attach`) and picks up the partial text, and a
`turnComplete` broadcast tells any recovered screen when to re-read the
saved conversation. This fixes, for Rise, the exact gap Phase 0 documented in
the per-call coaching chat (which drops its in-flight answer on navigation).

**3. A real Stop button.** `assistant:cancel` aborts the actual provider
call through the fallback walk's AbortSignal (the BUG-060 lesson: cancel
must reach the work, not just the UI). A stop mid-answer KEEPS the partial
text as the reply — words the user already read are work product. A stop
before any token arrives discards cleanly. Rise is the first surface in the
app with a working streaming cancel.

**4. Citations: every claim traceable, now visible.** Retrieved memories
enter the prompt numbered (`[1] …`), the model is instructed to cite, and the
renderer turns markers into tappable chips → an evidence modal showing the
memory's status ("Trusted fact" / "Still a hunch"), confidence, and the
verbatim quotes it rests on, with "Open the call" deep links. Parsing never
trusts the model: markers the context didn't define are ignored. This is the
Memory Center trust rule surfaced in conversation — built on the new
structured retrieval API (`retrieveRelevantMemoriesStructured` in
`src/main/memory/rag.ts`), which is also what Phase 2's measurement harness
will drive. One build, two consumers.

**5. Retrieval includes hypotheses, hedged.** A young install's Sales Brain
is ALL hypotheses; retrieving only "trusted facts" would make Rise say
"I don't know" while Memory Center visibly holds the answer (the Phase 0
credibility trap). Hypotheses arrive marked "(still unconfirmed)" and the
prompt requires observation-phrasing, never fact-phrasing.

**6. Tools are a one-round dispatch, not an agent loop.** Phase 0 found no
tool-calling loop exists anywhere and no provider streams tool deltas. So a
turn runs: one forced `plan_research` call (which lookups would help — often
none) → lookups execute in plain code against local data → the answer streams
with results in context, call results citable like memories. Available
lookups: search past calls, find a contact (joined with their deals), find a
deal (joined with its contact), today's schedule (local + Google + Outlook
caches, adopted-event dedupe). **Reads are free; writes are confirmed**: a
task request becomes a proposal chip persisted on the message (the BUG-048
rule — AI output never lives only in component state); confirming creates
the task exactly once (atomic accept-then-create with rollback). Honest
degradation: no tool-capable model → no lookups, chat still answers from
profiles + memories.

**7. Save-chips reuse the M25 machinery.** The same `extractContextSuggestions`
pass runs on the user's message; on this global surface only `memory`-type
chips (rep/business scope) are offered — KYC/call-notes/next-steps need a
bound call/contact, which Phase 1 doesn't have. Applied chips write through
`consolidateNewCandidate` with `source: 'user_stated'` and evidence pointing
at `assistant:<conversationId>` (the onboarding convention). No silent
writes, ever.

**8. Its own AI purpose: `assistant-chat`.** Quality-lane chain,
coaching-chat-tier budgets (45s per attempt, 120s hard ceiling, 1 same-model
retry, legacy tail 1), its own Settings card, its own health row. Added to
every hand-kept exhaustive purpose map — including `ASSIGNABLE_PURPOSES`,
with a red-checked test guarding the exact BUG-079 drift shape.

## Cost profile (honest)

A Rise turn costs up to 3 AI requests: the plan call, the streamed answer,
and the suggestion pass (5s-bounded), plus one more per task proposal. On
free-tier keys this adds pressure to the shared budget BUG-058 manages; the
existing per-model pacing/cooldown gates apply (purpose is durable-tier, so
it participates in cross-purpose pacing). If field evidence shows the plan
call hurting free-tier users, the cheap lever is gating dispatch behind a
"needs-tools" heuristic — deliberately NOT built yet (unmeasured).

## Verification notes

- All engine claims are unit-tested through the real IPC handlers and the
  real file store (temp dirs), with red checks on: cancel reaching the
  provider signal (3 tests fail without it), the conversation lock (6 fail
  without it), assignability (2 fail without the allowlist entry), and
  no-double-create (1 fails without the accepted guard).
- **Live-UI verification is deferred and owed**: the dev app shares
  `userData` (`AppData\Roaming\sales-os`) with the installed app, so it
  cannot safely run while the installed app is up (cache-lock errors
  observed 2026-08-21; two instances would also share every JSON store).
  Verify with the installed app closed, or after a packaged build.

## Deferred / not built (deliberate)

- Draft-email tool: needs contact binding to be useful; comes with the
  contact-aware phase, via the propose→confirm shape.
- Conversation-scoped contact binding ("talk about Dana" pinning her
  profile into every turn) — natural Phase 2+ extension of the same context
  assembler.
- Chat-as-memory-source (automatic extraction from conversations) — Phase 2,
  through the same consent/allowlist funnel calls use.
- Dispatch gating heuristics, transcript-deep call search, reranking — all
  wait for the Phase 2 harness so improvements are measured, not vibed.
