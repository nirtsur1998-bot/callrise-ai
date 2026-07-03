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

**Not yet done:**
- Existing local data (calls/tasks/summaries/events) is **not tied to a user** yet — a later milestone will stamp records with `user.id` (or move them into Supabase) so data is per-account.
- **Google/Outlook two-way calendar sync** is a deliberate later milestone (M7 laid the local foundation for it).
- Then: coaching, analytics, CRM, knowledge base.

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
