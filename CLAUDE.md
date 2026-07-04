# Sales OS — Project Guide

## What we're building

Sales OS is a desktop application that acts as an AI assistant for sales calls. Today it is a thin, static UI shell. Over time it will grow into a tool that listens to live calls, transcribes them in real time, and coaches the rep with in-the-moment suggestions — alongside a CRM, tasks, calendar, analytics, coaching, and a knowledge base. The long-form product vision lives in [`docs/VISION.md`](docs/VISION.md).

## Progress

Milestones completed:

- **M1 — App shell.** ✅ Electron + React + Tailwind desktop shell (dark Linear/Raycast layout: sidebar nav, main view, copilot panel).
- **M2 — Live transcription.** ✅ Real-time microphone transcription via Deepgram Nova-3, with speaker labels.
- **M3 — Saved calls.** ✅ Calls saved to disk with speaker diarization; Past Calls list + detail view.
- **M4 — AI summaries.** ✅ Claude summaries of saved calls and attached files (PDF/txt/md/docx), via the main-process `.env` relay.
- **M5 — AI tasks.** ✅ Generate action items from a saved call (review/edit/accept) + a real Tasks screen (list, filters, complete/edit/delete/add).
- **M6 — User accounts + email auth.** ✅ Sign-up / log-in gate via **Supabase Auth**, with email confirmation by a 6–10-digit code (no redirects/deep links). Auth runs in the main process (keys in the gitignored `.env`); the signed-in user shows in the sidebar with log-out.
- **M7 — In-app calendar (foundation).** ✅ Custom month + week grid (date-fns; no calendar library), local event storage (one JSON file per event, mirroring tasks/calls), create/edit/delete events, and a read-only overlay of tasks (on due dates) + past calls (on the day/time they happened). Events store `source: 'local'` + empty `provider`/`externalId` hooks and absolute ISO times so the future Google/Outlook sync needs no migration. **No external sync yet** (deliberately deferred).
- **M8 — AI post-call coaching (scorecard).** ✅ "Coach this call" on a saved call → a Claude-scored, evidence-grounded scorecard: 6 rubric dimensions (1–5), a computed 0–100 Call score, deterministic metrics (talk ratio, longest monologue, question count, pace, turns), a lead strength, top-2 prioritized improvements (mechanical + strategic), and one next-call action (savable as a task). Every cited quote is **verified against the transcript** and ungrounded advice is dropped. Persisted on the call (`coaching` field); the **Coaching** screen lists coached calls. **No live/in-call coaching yet** (that's M9).
- **M9 — Live in-call coaching (foundation).** ✅ Real-time cues on the **Live Calls** screen. On each completed client turn (single-flight, ~400ms-debounced, fail-fast on 429/529 rate limits), a fixed speaker-labeled transcript window goes to **Claude Haiku**, which identifies the rep and returns ONE glanceable, grounded cue — **objection / discovery / next-question / buying-signal** — about what the client said; plus a **rep-only** deterministic "slow down". Rep is auto-identified from their self-intro and locked for the call; **mute** + Low/Med/High sensitivity; one cue at a time, dismissible. Also a manual **"Ask the coach"** box that sends the running transcript for in-context help. Reuses M8's coaching standards; typical cue latency ~0.5s.
- **M10 — Analytics dashboard.** ✅ A read-only **Analytics** screen that turns data already on disk into meaning — **no new data, no AI, no new storage**; all aggregation is deterministic (counting/averaging), so it works offline and instantly. Reuses the existing IPC (`calls.list`/`calls.get`/`tasks.list`). Five cards: activity over time (calls per week/month), talk-to-listen ratio, per-skill coaching scores, "where to focus" (lowest non-green skills + a concrete action), and task follow-through. Every card answers "so what?" — a green/amber/red **health tone** (reusing the coaching `Tone` tokens), a one-line plain-English **verdict**, and a hand-rolled SVG/CSS bar (no chart dependency). A single deterministic **headline** picks the biggest takeaway. Metrics from fewer than 3 coached calls are caveated ("early days — based on N calls"). Logic lives in `features/analytics/` (`aggregate.ts` = data, `verdicts.ts` = meaning, `charts.tsx` = bars).
- **M11 — Recording-consent foundation.** ✅ The required safety layer **before** any buyer-side capture (M12). Each call carries a `ConsentRecord` (status `not-asked`/`disclosed`/`consented`/`declined`, jurisdiction one/two-party, how consent was obtained, timestamps, and a `recordOtherParty` flag), stored on disk with the call — **no new storage**. **Hard invariant:** `recordOtherParty` is only ever true when `status === 'consented'` — recomputed in the main process `sanitizeConsent` on **every save AND every read**, so a hand-edited/malformed file can't grant capture. This is the flag M12 capture must gate on ("no consent = no capture"). UI (`features/consent/`): an **"Other party" control** in the live bar that can't flip on directly — only the **consent modal** (gate + editable disclosure script + how-consent-was-obtained + jurisdiction; default **two-party**) can enable it via an explicit "they said yes". Consent **resets to off after every call**. A persistent, **honest recording indicator** says "Recording — your mic" while mic-only (with a "buyer capture arrives in M12" note when consent is on); the "you + the other party" variant is built but stays OFF until M12. One-line guardrail notes that consent laws vary by location. **No audio capture of the other party in this milestone** — mic capture is unchanged.
- **M12 — Buyer-side audio capture + dual-side transcription.** ✅ Captures the other party via **macOS system-audio loopback** (`getDisplayMedia`; no external driver, no dependency), merged with the mic through one `AudioContext`/`ChannelMergerNode` into interleaved stereo, streamed over **one Deepgram multichannel socket** → deterministic **You (ch 0) / Buyer (ch 1)** labels (no diarization guessing). **Consent-gated & double-gated:** buyer capture opens only from the consent modal's "they said yes" **click**, and the main-process display-media handler **denies** any request that wasn't armed after consent — capture is gated in main as well as the renderer. **Retention backstop:** the main process **strips buyer turns on save, read, and list** unless consent still permits it (so revoking mid-call, or a hand-edited file, never surfaces the other party). Honest recording indicator (**"you + the other party"** only when buyer audio is truly streaming) + failure recovery (Screen-Recording settings deep-link, Try-again/Resume). New Home **"Audio sources"** section picks the recording mic and shows the current output with a headphones reminder. Live cues get the known rep channel. Built in de-risked steps (packaged-build permission check → Deepgram-multichannel probe → stereo worklet → socket plumbing → consent wiring → retention → recovery UI → cue labels), verified with adversarial bug-hunt + runtime proofs. **macOS only; mic-only calls unchanged.**
- **M13 — Google Calendar sync, READ-ONLY (step 1 of the calendar-sync arc).** ✅ Connect Google Calendar and pull the user's meetings INTO the app's calendar, read-only — no writing to Google, no Outlook, no conflict logic (those are M14/M15). The user authorizes in their **own system browser** (loopback + PKCE; the app never sees the password); the refresh token is stored **encrypted via `safeStorage`** (macOS Keychain) in the main process, never exposed to the renderer. Requested scope is `calendar.readonly` (read-only). Events are pulled (30 days back → 90 forward, all calendars, recurring expanded, cancelled dropped) into a **separate read-only cache** (`google-cache/`), mapped to the existing `CalendarEvent` shape with `source:'google'` + `provider:'google:<calId>'` + `externalId` (the match key M14 will use), and shown on the calendar grid as **green, read-only chips**. Refresh on calendar-open + a manual Refresh (no background polling); clean disconnect/reconnect. Lib: `google-auth-library` only. Security-reviewed (read-only, encrypted tokens, safe OAuth all verified). Setup (Google Cloud project, consent screen, Desktop OAuth client, credentials in `.env`) is done by the user in Google's own screens.

**Not yet done:**
- Existing local data (calls/tasks/summaries/events) is **not tied to a user** yet — a later milestone will stamp records with `user.id` (or move them into Supabase) so data is per-account.
- **Two-way + multi-provider calendar sync** (M13 did read-only Google pull-in): **M14** = push app events OUT to Google + two-way conflict/duplicate handling (will need a write scope and the `(provider, externalId)` match key M13 set up); **M15** = add Outlook on the proven engine.
- **M12 capture limitations** (deliberate, documented in-app): loopback grabs **all** system audio, so the rep must close other audio and **use headphones** (or the buyer bleeds into the mic and both sides double-transcribe); no per-app/per-window isolation yet; consent is confirmed **mid-call** (no pre-Start consent screen); transcript-only (raw buyer audio is never stored). **Windows buyer-side audio** is a separate later milestone (M12 is macOS-only).
- Then: CRM, knowledge base.

## Stack

- **Electron** — desktop shell (main + preload + renderer processes)
- **React 19 + TypeScript** — renderer UI
- **Vite** via **electron-vite** — dev server, hot reload, and bundling
- **Tailwind CSS v4** — styling, via the `@tailwindcss/vite` plugin; theme tokens live in `src/renderer/src/index.css`
- **lucide-react** — icons
- A **Python / FastAPI** backend is planned for **later**. It does **not** exist yet — do not add Python or any backend until we explicitly start that phase.

## Project structure

```
src/
  main/        Electron main process (creates the window)
  preload/     Secure bridge between main and renderer
  renderer/
    src/
      app/         App shell + top-level layout
      features/    One folder per feature (navigation, home, copilot, …)
      components/  Shared, reusable UI primitives (Card, …)
      lib/         Small helpers (cn, …)
      index.css    Tailwind import + dark theme tokens
docs/
  VISION.md    Long-form product vision (owned by the user)
```

## Conventions

- **TypeScript strict mode** is on. Avoid `any`; prefer precise types.
- **Feature-based folders.** New functionality goes in `src/renderer/src/features/<feature>/`. Shared pieces graduate to `components/` or `lib/`.
- **Small, clean commits** — one coherent change per commit, with a clear message.
- **Dark-mode-first UI**, visually inspired by Linear, Raycast, and Arc: calm dark surfaces, clean typography, generous whitespace, soft rounded cards, and a single restrained indigo accent.
- **Path alias:** import renderer code via `@renderer/...`.

## How we work together (standing rules)

- Work in **small, runnable steps** — after each step, the app should still start.
- **Explain in plain language** — the user is newer to coding.
- **Pause and ask for confirmation before big or irreversible changes**: new major dependencies, architectural shifts, deleting things, or anything touching many files. When in doubt, ask instead of guessing.
- Keep scope tight: **no backend, no audio, no AI, no live features** until we plan that work explicitly.
- **Work in the main folder and commit directly to `main`.** The user is a solo beginner and runs `npm run dev` from the main project folder, so all work must land there. Edit the main checkout directly and commit straight to `main` — do **not** use feature branches or `.claude/worktrees/…` (the branch/worktree dance caused confusion where finished work wasn't visible in the running app). This overrides the default "branch before committing on the default branch" behavior. Still commit only when the user asks.

## Common commands

- `npm run dev` — start the app in development (opens the window, hot-reloads on save)
- `npm run build` — typecheck and build for production
- `npm run typecheck` — types only
- `npm run lint` / `npm run format` — lint / format
