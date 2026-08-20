# M28 Phase 0 — Codebase map (2026-08-20)

Produced by six parallel research passes over this worktree (`claude/m28-rise` off
`main` @ `14969ab`, post-1.3.2) before any M28 code. Companion to the milestone
brief; `docs/M28-rise.md` (architecture + decisions) comes after the founder
checkpoint. Numbering note: the brief's "M23 coaching chat" is the Coaching Chat
shipped on branch `claude/m23-coaching-evolution`; "M25 Sales Brain" is branch
`claude/m25-sales-brain`.

## 0. The findings that change the plan

1. **There is no tool-calling loop anywhere in the app.** Every AI call is either
   a plain stream or a *single forced* tool call for structured output
   (`AICompletionRequest.tool`, one tool, no tool-result round trip — stated by
   design at `src/main/ai/types.ts:7-11`). Phase 1's "the model decides to search
   calls / draft an email" is new infrastructure, not an extension. Also:
   streaming and tools do not combine today — no provider `stream()` emits tool
   deltas.
2. **Chat history has no home.** The only chat store is `Call.coachChat` inside
   each call's JSON (`calls-fs.ts`, `appendCoachChatTurn`, per-call lock). A
   global conversation list needs a new store + `list/load` IPC (options: a
   `conversations` table in `memory.db` — migration infra exists, version 3 —
   or `userData/conversations/<id>.json` mirroring calls-fs's atomic-write +
   per-id lock pattern).
3. **Memory citations are impossible through today's retrieval API.**
   `retrieveRelevantMemories(query, contactId)` (`src/main/memory/rag.ts`)
   returns a formatted prompt *string* — no ids, no evidence, no distance. The
   data model underneath is citation-complete (verbatim verified quotes, callId,
   `invalidatedBy` chains, exposed to preload) but **no renderer surface renders
   evidence anywhere**. Needed: a structured sibling API (thin —
   `searchMemoriesByVector` already returns `{memory, distance}[]`) + evidence
   IPC + UI. The same structured API is exactly what the Phase 2 retrieval
   harness needs — one piece of work serves both.
4. **Retrieval is vector-only and active-only.** No hybrid ranking (the
   "relevance × recency × importance" comment in `memories-store.ts` was
   deferred and never built — already logged as M27 finding C3); hard
   `MAX_DISTANCE 0.6`, 5 results across all scopes; proper nouns/exact terms
   underperform (MiniLM-384, no keyword fallback). Default `statuses:['active']`
   means a young install retrieves *nothing* while Memory Center visibly holds
   hypotheses — a chat that says "I don't know" next to a full Memory Center is
   a credibility problem. Phase 2's measured-improvement plan lands on fertile
   ground; the harness Q&A extension can run **offline** (embeddings are local
   transformers.js, no API key).
5. **Two retrieval-path robustness gaps for a foreground chat:** `embedText()`
   has no timeout and can block on the one-time ~23MB model download
   (`coaching-chat-ipc.ts` awaits it inline, unlike the suggestion pass which
   uses `withTimeout`); `rag.ts`/`profile-injection.ts` use bare `getMemoryDb()`
   (silent `''` on failed init) where a foreground click is the documented case
   for `ensureMemoryDb()` (`memory-runtime.ts:163-171`).
6. **Voice cannot reuse `transcription:start` as-is.** It unconditionally calls
   `beginCall()` (`transcription.ts:1152` → `live-transcript.ts:141`): opens an
   on-disk CallJournal (an unmatched one resurfaces as an "interrupted call"
   recovery prompt on next launch), flips `hasLiveCall()`, and feeds the cue
   engine. Fix shape: `mode: 'call' | 'utterance'` on `StartOptions` skipping
   beginCall/recordResult, or factor a `DeepgramStream` class both consumers
   instantiate. The module is also a single global session — concurrent live
   call + voice chat requires the refactor. **Good news:** call detection is
   process/window-based and consent is loopback-only — mic-only capture trips
   neither (verified paths: `detection-service.ts` excludes `ourPid`; consent
   gate only via `loopback:arm`). The clean record-only precedent is
   `useMicTest.ts`/`mic-test.ts`.
7. **Realtime voice doesn't fit the `AIProvider` abstraction, by design** —
   text-completion only (`complete`/`stream`/`validateKey`/`listModels`;
   `docs/ai-providers.md:116` keeps audio outside the layer). Phase 4's native
   path is its own module (renderer WebRTC + main-minted session token), which
   matches the brief. No vision/TTS/realtime/image input exists anywhere; the
   only multimodal today is single-PDF `document`.
8. **BUG-079 found during this pass** (logged in the vault tracker, hotfix chip
   raised): `ASSIGNABLE_PURPOSES` (`catalog-ipc.ts:10`) omits `coaching-chat`
   and `memory-extract` while Settings renders cards for both — assignment is a
   silent no-op. Verified against source at `14969ab`. Cautionary tale for M28:
   when we add an `assistant-chat` purpose, the purpose maps are hand-kept
   exhaustive records in ~6 places (deliberately — "a 13th purpose must force a
   decision") and this is what drift looks like.
9. **Streaming chat must survive navigation by architecture, not luck.**
   `MainApp.tsx` wraps screens in `<div key={active}>` (force-unmount per
   switch) and swaps to a wholly different tree for Settings. The existing
   coaching chat drops in-flight deltas on unmount (final turn persists; partial
   text lost, no re-attach — `streamingIdRef` is renderer-local). The two proven
   survival patterns: an out-of-tree provider mounted as a sibling in `App.tsx`
   (LiveCallProvider / ActivityCenter precedent), or model the turn as a job
   (`useJobByTarget` + `adoptStates:['succeeded']`, main buffers accumulated
   text). Recommendation: sibling provider for chat session state.

## 1. Coaching chat (the pattern to grow from)

- UI: `src/renderer/src/features/coaching/CoachChatPanel.tsx` (~335 lines;
  `Bubble` with streaming cursor, chips, `TaskProposalCard`/`CrmNoteCard`,
  composer). Hook: `useCoachChat.ts`. Types: `coaching/types.ts:168-213`.
- Streaming shape (the app's only precedent, documented in-file): renderer
  `invoke()` resolves with the final text; `coachChat:delta`/`:error` pushed
  mid-flight via `broadcast()` (all windows — renderer filters by callId; a
  multi-surface world should filter by conversationId or use targeted send).
- Main: `coaching-chat-ipc.ts` (7 handlers, `registerCoachingChat()`), pure
  prompt/context assembly in `coaching-chat.ts` (no Electron import — the
  testability convention).
- Context assembly (`assembleChatContext`): call title + Sales Brain (full rep +
  business + client profiles + per-message RAG) + scorecard + skill graph +
  focus skill + transcript (`MAX_TRANSCRIPT_CHARS 100_000`) + KYC + 5 past
  calls + notes. All char/item caps, no tokenizer. Rebuilt fresh every turn.
- Save-chips: `extractContextSuggestions(userMessage, contactId)` — forced tool
  call over **only the rep's message text** (global-ready; contactId gates kyc +
  client-memory types). Allowlist `KYC_UPDATABLE_FIELDS` (19 fields, identity
  fields excluded). Apply path re-validates server-side (`kyc-apply.ts`,
  shared with the CRM note generator). Memory chip → `consolidateNewCandidate`
  with `source:'user_stated'` (starts active, skips promotion) — global-ready.
- Action triggers are **buttons, not intent detection**: propose→confirm
  two-phase for tasks (`PROPOSE_TASK_TOOL` → local-state card →
  `confirmTask` → `createTask`); draft email writes straight into the thread
  (no confirmation — for Rise, writes get chips per the brief); CRM note
  propose→save. Proposals live only in component state (lost on unmount) —
  a persistent chat should store pending proposals with the message.
- Reusable nearly as-is: streamWithFallback; the delta-broadcast IPC shape;
  Bubble/composer (extract to `components/chat/`); the chips machinery;
  applyKycField; the whole memory layer; propose→confirm. Needs redesign:
  persistence (call-embedded), callId-as-key everywhere, `assembleChatContext`
  (call-hardcoded — rewrite retrieval-first), `handleSend` (hard-fails without
  a call), practice mode (drop for the global surface).

## 2. Sales Brain (memory)

- Store: `memory.db` (better-sqlite3 + sqlite-vec, WAL; schema v3 in
  `memory/migrations/index.ts`): `memories` (scope, category, statement,
  evidence JSON, confidence, importance, status, source, pinned,
  invalidated_by, timestamps) + `vec_memories` float[384] + `compiled_profiles`
  + `backfill_attempts`.
- Domain (`memory/types.ts`): scopes `rep | business | client:<contactId>`
  (**no deal scope**); 14 hard-allowlisted categories with
  `CATEGORY_SCOPE_KIND` consistency enforced in code; status
  active/hypothesis/invalidated/archived; source auto/user_stated/
  user_confirmed; evidence = verified-verbatim transcript quotes or reflection
  memory-id lists.
- Profiles: deterministic compiler (`consolidation.ts`), char budgets
  micro 500 / standard 1800 / full 4200, `importance × confidence` greedy pack,
  **active-only**, statement bullets only (no ids/evidence carried). Injected
  via `profile-injection.ts` (pure DB reads, `''` when disabled). Coaching chat
  is the only 'full'-size consumer.
- Retrieval: `rag.ts` (see plan-changers #3-5). Raw primitives:
  `embedText` (local MiniLM-384) + `searchMemoriesByVector(db, emb, {scope,
  limit, statuses})`.
- Extraction: `extraction.ts` — tool schema built from the category allowlist,
  guardrail prompt (no mental/health/family; source text is data not
  instructions), `verifyEvidenceQuote` anti-hallucination containment check,
  `ExtractionOutcome` distinguishes AI-failed from nothing-found (BUG-057).
  Orchestrated by `memory-hooks.ts`; BATCH-lane job
  (`memory-extraction-job.ts`), silent (custom review toast instead).
  Post-save pass passes `contactId=null` unconditionally (can never store
  client-scope); post-coach freezes contactId at trigger time.
- Consolidation: single write funnel `consolidateNewCandidate` (exact match →
  vector ≤0.35 + AI same-fact judge → reinforce; contradiction judge →
  supersede-never-delete with forward link; else insert). Promotion at 3
  episodes; reflection hypothesis-gated ≥2 evidence, confidence cap 0.5; decay
  (14d grace, 60d half-life × episodes, skips pinned/user_*) demotes at 0.4,
  archives at 0.15. Nightly = MAINTENANCE-lane job every 20h.
- Consent: master `isSalesBrainEnabled()` (default OFF) + per-call
  `salesBrainExcluded`, both **read fresh inside job executors** (deliberate,
  documented `memory-hooks.ts:112-117`); scope frozen at trigger. Retroactive
  exclusion deletes every memory from that call ("zero trace"); known layering
  gap: deletion is whole-memory, not per-evidence-entry. Phase 2's
  chat-as-source must enter through this same path.
- Memory Center: `MemoryCenterSection.tsx` (settings route
  `sales-brain-memories`), `MemoryReviewModal` (app-level, dismiss-only), IPC
  `memory-center-ipc.ts` (list/update/pin/delete/forget/changelog/byCall +
  setExcluded). Shows statement/status/confidence/category — **no evidence
  rendering anywhere** (see plan-changers #3).

## 3. M27 eval harness

- `src/main/memory/__tests__/memory-quality-eval.test.ts` + fixtures reusing
  M24 Call Simulator transcripts (3 scenarios, 15 ground-truth facts). Runs the
  real extraction pipeline; measures recall + a narrow forbidden-topic
  false-positive check (precision proper not computed). Report printed, human-
  read, not asserted (deliberate). Explicit skip (not silent) without a key —
  any of the 8 provider env vars. **No baseline yet — still waiting on the
  founder's throwaway free-tier key; numbers are model-specific, so
  before/after must pin the same key+model.**
- Retrieval extension (Phase 2): mostly a fixtures + DB-seeding problem —
  offline-capable, needs a golden memory corpus, Q&A fixture type
  ({question, contactId, shouldSurface: ids}), stubs for `isSalesBrainEnabled`/
  `getMemoryDb`, and the structured retrieval API from plan-changers #3.

## 4. AI infrastructure (picker, chains, capabilities)

- Catalog `model-catalog.ts`: 12 entries (groq/cerebras/google/nvidia/
  openrouter/mistral); anthropic + openai have **zero entries** — they enter
  chains only as the "legacy step" from `settings.aiProvider`. Exactly two
  flags, both negative: `knownStale`, `supportsToolCalling?: false` (undefined
  = assumed capable; one entry sets it). No vision/TTS/realtime/pricing fields.
- Chains: `resolveChain(purpose, {needsTool})` → `{configured, capable}`;
  configured assignment wins → legacy + implicit tail (`LEGACY_TAIL_MAX`) →
  bundled `DEFAULT_CATALOG_CHAIN`. Keys re-read from `process.env` per
  resolution (safeStorage-encrypted at rest, loaded at startup).
- `streamWithFallback` (only consumer: coaching chat): hard wall-clock ceiling
  (`HARD_CEILING_MS`, M27 A1), same-model retry pre-first-delta only, dead-
  provider early exit, fallback only before first delta. **No renderer Stop
  affordance exists — the ceiling is a backstop, not a cancel button.** Rise
  needs a real cancel (both walks accept `signal`).
- Cooldown/pacing/capacity: `model-cooldown.ts` (isUsableFor is the single
  gate), `model-pacing.ts` (6s default, per-provider groq 2s / openrouter 3s,
  live-exempt), `capacity.ts` (job deferral), `failure-class.ts`
  (transient/period-exhausted/structural), `purpose-health.ts` (the honest
  "why is AI degraded" machinery — reuse for Rise's degradation messaging),
  `fallback-log.ts`.
- Adding a purpose (`assistant-chat`) forces hand-updates in: `AIPurpose` +
  `LATENCY_POLICY` + `SAME_MODEL_RETRY_LIMIT` + `HARD_CEILING_MS` (types.ts),
  `DEFAULT_CATALOG_CHAIN` + `LEGACY_TAIL_MAX` (complete-with-fallback.ts),
  `DEFAULT_MODEL_ASSIGNMENTS` + `sanitizeModelAssignments`
  (model-assignments.ts), `ASSIGNABLE_PURPOSES` (catalog-ipc.ts — see
  BUG-079), Settings `JOBS`, preload types. Exhaustive by design; miss one and
  you get BUG-079's shape.
- Capability flags for later phases (`supportsVision`/`supportsTTS`/
  `supportsRealtimeVoice`): CatalogEntry fields + generalizing the one
  hardcoded `needsTool` filter dimension in resolveChain/capacity + provider
  adapters + UI badges. ~11 files; enumerated in the Phase 0 session log.

## 5. Platform services

- **Jobs** (`src/main/jobs/`): lanes LIVE ∞ / INTERACTIVE 2 / BATCH 1 /
  MAINTENANCE 1; `registerType`+`enqueue` per-feature (no generic IPC enqueue,
  by design); `useJobByTarget(jobType, targetRef, {adoptStates})` adopt-on-
  mount/notify-once; `Job.resultData` + `retainUntilConsumed` for review-
  before-save output; capacity gate defers BATCH/MAINTENANCE when no AI
  capacity. Guide: `docs/M26-job-adapter-guide.md`.
- **Notifications**: `showNativeNotification` helper; ToastProvider
  (`useToast`); ActivityNotifier DND — LIVE-lane running ⇒ starts dropped,
  completions digest on call end; `job.silent` opt-out; OS notifications only
  unfocused + setting-gated, read fresh.
- **Contacts/deals/tasks/events**: flat JSON per record under userData
  (contacts-fs/deals-fs/tasks-fs/events-fs + IPC modules). No server-side
  search — palette loads full lists and substring-filters client-side; Rise's
  search tools should add main-side helpers (scale is fine). Contact deletion
  refuses with deals attached. Deep-link = one-shot preselect props
  (`openContactId`/`openDealId` → `setActive('crm')`), consumed via
  `onInitialSelectionConsumed`; OS-level deep link exists only for
  `callrise://meeting/<id>`.
- **Calendar**: Google + Outlook OAuth, local events (`events-fs.ts`, sync
  states) + per-provider caches; "today's meetings" has **no dedicated query** —
  renderer merges 5 sources (`useCalendar.ts:74-80`); a chat tool/morning brief
  needs a main-side merge helper. Per-meeting AI brief cache exists
  (`prep-brief.ts`, `getCachedPrepBrief`).
- **Email**: `generatePostCallBrief()` returns `{emailSubject, emailBody}`; no
  mail-client integration — drafts are copy-text. Tasks: `createTask` direct,
  or the propose→confirm chat shape (`coachChat:proposeTask`/`confirmTask`).

## 6. Shell / navigation / styling

- Add a section: `NavId` union + `NAV_ITEMS` entry in
  `features/navigation/nav-items.ts` (order = grouping) + lazy view arm in
  `MainApp.tsx`. Sidebar + CommandPalette derive automatically. No router.
- Out-of-tree survivors mount as App.tsx siblings (ActivityCenter,
  LiveCallPill, InterruptedCallPrompt, LiveCallProvider) — the pattern for
  chat-session state. `liveCallNav.ts` shows how an out-of-tree component
  navigates into a section.
- **No central name constant exists** ("CallRise AI" is hardcoded ~10 places).
  For NAMING: `src/renderer/src/features/<section>/config.ts` exporting
  `SECTION_NAME` + `SECTION_NAV_ID`, referenced from the NAV_ITEMS entry.
- No i18n (inline English). Tailwind v4 CSS-first, semantic tokens only
  (bg-canvas/surface/elevated, text-ink/muted/faint, accent, status families),
  dark-first with `:root.light` override; hand-rolled components in
  `src/renderer/src/components/`; lucide icons; `cn()`; explanatory file-header
  comments are the house style.

## 7. Verification notes for later phases

- `npm run typecheck` (bare tsc is a no-op); full suite via `npm test`
  (scripts/run-tests.mjs — real exit code, never piped tail; species 14).
- Bundle-level verification for anything shipped (`scripts/verify-bundle.sh`);
  clean-Windows install + second-PC pass before release (1.3.x rule).
- Claim-audit table per phase (model: `docs/M27-claim-audit.md`).
