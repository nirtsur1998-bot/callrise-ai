# M31 — Design, Identity & Discoverability: Stage 0 Audit

**Date:** 2026-08-29 · **Base:** `origin/main` @ `61313ba` (v1.5.0) · **Branch:** `claude/m31-design-identity` (worktree `callrise-m31`)
**Method:** five parallel read-only code inventories of the entire renderer + main process, plus direct verification of every default in `app-settings.ts` / `prefs.ts`. **Environment note: every claim here is from reading the shipped code — nothing in this document is click-tested in the running app.** Screenshot baselines are owed at Stage 1 start (the app was in active use on the founder's machine during this audit).

**Milestone number:** M31 was claimed after grepping the Milestone Tracker and both repos for `M3[1-9]` — M30 was the highest number in use anywhere.

---

## 0. Executive summary (plain language)

You said two things: the app *"feels boring, like a shell,"* and *"even I only understand 50% of my own features."* The audit confirms both — and finds the brief's premise half-stale in a way that makes the milestone **cheaper and safer** than planned:

1. **A real design system already exists.** An "app-wide design system + UX overhaul" landed on 2026-07-16 (commit `668e04d`): Tailwind v4 CSS-first tokens in one file, dark + light themes fully wired, 19 shared UI primitives with strong adoption, a grouped sidebar, a working ⌘K command palette with entity search, a keyboard-shortcuts overlay, and an EmptyState component. Only 10 hardcoded colors exist in 46,000 lines of UI code. **Stages 1–2 of the brief are partly built.**

2. **But the identity it encodes is the exact banned one.** The token file's own comment says it: *"Inspired by Linear / Raycast / Arc … one restrained **indigo** accent."* Accent `#6e7bf2` (indigo), `'Inter'` in the font stack — **with no font actually bundled, so on Windows you see Segoe UI, the OS default font** — and an indigo→purple gradient as the brand mark. Your "boring shell" instinct is validated by the code: a competent, anonymous Linear clone in the default Windows font. **Stage 0c (identity) is the real work, and the token architecture makes applying it cheap.**

3. **The "50% invisible" number is real, and it isn't the sidebar's fault.** The sidebar is fine (12 items, 4 groups). The inventory found **~40 distinct stranded features**: 13 whole features ship **off by default with zero visible trace** (Deal Intelligence, Coach 2.0 + the skill graph, Sales Brain, Objection Library, Contact Intelligence, ambient detection, Windows noise cancellation, and six automation toggles), plus features whose output goes somewhere invisible (a follow-up email written silently to the clipboard; a memory review reachable only from a transient OS notification), plus one genuine trap (a toggle that silently does nothing unless a differently-named toggle on a different page is also on). **The fix is a discoverability policy, not just a prettier nav.**

4. **The notification spam you reported this morning is diagnosed** (§4): per-launch maintenance jobs mint visible Activity entries into an ungrouped 500-entry list, and the "rare, once per sign-in" sync job may actually fire every launch. Design fix scoped; one possible bug flagged for separate verification (BUG-129).

**What I need from you to proceed:** approve (or amend) the IA proposal in §5, and pick one of the three identity options in §6. No UI code has been written.

---

## 1. What the brief assumed vs. what exists

| Brief assumed | Reality at v1.5.0 |
|---|---|
| No design system, hardcoded styles | Tailwind v4 `@theme` tokens in one file (`src/renderer/src/index.css`); 10 hex literals total in `.tsx` across 46k LOC; 19 shared primitives (`Button` 174 uses, `Card` 36 files, `Modal` w/ full a11y, `EmptyState` in 13 files) |
| Stand up Tailwind v4 + tokens (Stage 1) | Already on Tailwind v4.3.2, CSS-first `@theme`, React 19, Electron 39. No Radix/shadcn/cmdk/sonner/framer-motion — everything custom, zero UI deps |
| Build a sidebar with grouped sections (2a) | Exists: Workspace / Pipeline / Insights / Library + Settings, icons+labels, active states, Recent trail |
| Build a ⌘K palette (2b) | Exists (hand-rolled, good a11y): nav + 2 quick actions + contact/deal/call search + recents; visible "Jump to…" ⌘K button in sidebar |
| Empty states are blank/generic (3a) | Mixed: an `EmptyState` primitive exists and some copy is excellent (Rise's four-state hero is the house gold standard); many others are blank, hidden, or dishonest (§3) |
| No dark/light discipline | Both themes complete, three-way switcher, `prefers-reduced-motion` handled app-wide |
| Identity needs choosing (0c) | **Correct — and the current identity is the banned trifecta: indigo accent + Inter-stack (unbundled → Segoe UI) + purple gradient brand mark** |

**What this changes:** Stage 1 shrinks to a token/type-scale hardening pass; Stage 2 becomes an upgrade, not a build; Stage 3 (discoverability + empty states + attention) grows into the biggest stage; Stage 4 (identity) is a one-file token swap plus a component sweep — exactly the "change the identity from one file" goal the brief asked for, already structurally true.

---

## 2. Stage 0a — Feature inventory

Full per-feature detail (primary action, discovery path, gating flag + verified default, first-run copy quoted from code, file paths) was compiled per area; this section is the condensed decision-relevant view.

### 2.1 The map today

**Sidebar (12):** Home · Rise · Live Calls · Past Calls · Tasks ‖ CRM · Calendar ‖ Coaching · Analytics ‖ Team · Knowledge ‖ Settings — zero conditional gating at nav level; every gate lives inside screens or Settings.

**Surfaces beyond the sidebar:** Settings (a second, complete shell — 22 pages / 11 groups, always opens on Account, **no deep links**); the right-hand "Voice AI" rail (a third settings surface duplicating five controls); the floating Activity button; the live-call pill; the detection overlay window (own always-on-top window); the tray icon (only when detection is on); toasts; native notifications; one deep link (`callrise://meeting/<id>`); the ⌘K palette; the `?` shortcuts overlay; onboarding (8 steps).

**The empty top bar:** the main shell's 56px header contains nothing — its one extension slot (`headerActions`) has zero callers. Every screen renders its own `PageHeader` instead.

### 2.2 Fresh-install defaults — the "50%" in one table

Verified in `src/main/app-settings.ts` (`DEFAULT_SETTINGS`) and `src/renderer/src/features/settings/prefs.ts`:

| Ships **ON** | Ships **OFF** (invisible until found in Settings) |
|---|---|
| Live coaching cues (sensitivity: low) | **Live Deal Intelligence** (the whole HUD + Radar Report) |
| Speaker-name resolution | **Coach 2.0** (skill graph, Progress dashboard, Focus Skill, methodology) |
| Buyer-recording *capability* (consent still per-call) | **Sales Brain** (all memory: extraction, Rise grounding, Memory Center content) |
| Calendar-match suggestions | **Objection Library** (mining, past-call scan, heatmap, review queue) |
| Needs-follow-up flagging (14 days) | **Contact Intelligence** ("Detect who this was") |
| Auto-open saved call page | **CRM Note Generator** card + **Auto-generated CRM notes** |
| Background-job notifications | **Ambient call detection** (+ tray icon + both global hotkeys + overlay + call-detected banner) |
| Auto-update | **Auto-transcribe detected calls** (inert anyway — see the trap below) |
| | **Noise cancellation, Windows Tier 1** (also absent from Home, unlike the Mac card) |
| | Auto-start listening · Auto-summarize · Auto-title · **Instant clipboard follow-up** |
| | All six cloud-sync scopes · telemetry (unasked) · standing consent |

A fresh install shows roughly **half the product**. The founder's "50%" was accurate.

### 2.3 The stranded-feature catalog (~40, deduped, by failure mode)

**A. No entry point at all**
1. **Battlecard library** — 30 curated objection/signal cards fire into live calls; no browser, no list, no way to see or edit a single built-in (`features/live/battlecards/library.ts`).
2. **Must-ask discovery checklist** — five chips + the pre-hangup warning; explained nowhere in the app.
3. **Post-call brief + follow-up email** — output goes **only to the OS clipboard**, never shown or stored in-app; announced by half a sentence in the "Call saved" banner.
4. **Memory review** — reachable only by clicking a transient OS notification; dismiss it and the review is gone forever (`MemoryReviewModal`).
5. **Sales Brain restore** — export exists; import is a sentence of prose inside an error string.
6. **Auto-stop watchdog** — ends auto-started calls after 5 silent minutes; no setting, no mention until after the fact.
7. **Session-health tiers** — surfaced as a 4-character label with the explanation in a native tooltip.
8. `speakerId.enabled` and `speakerId.voiceProfileMatching` — persisted flags with **no UI anywhere** (the latter is biometric-adjacent; see §8 privacy note).
9. **Scheduled Alerts** — entire page + 3 channels + 4 triggers fully built and permanently unmountable (`ALERTS_BACKEND_LIVE = false`; backend never deployed — known, deliberate, BUG-083).
10. Dead code: `PlaceholderView`'s fallback branch is unreachable; `headerActions` never used; "Team" nav renders a screen titled "Your Trend."

**B. Off-by-default with zero in-context trace** — the thirteen features in §2.2's right column. The pattern: turning a feature off removes its *entire surface* rather than showing an honest "this is switched off" state, so nothing in the product ever advertises that the capability exists.

**C. Discoverable in principle, buried in practice**
11. **The trap:** *"Auto-transcribe detected calls"* (Settings → AI Note Taker, also in the Voice AI rail, also the collapsed-rail icon — three surfaces) **does nothing** unless *"Ambient call detection"* (Settings → Call detection, a different page, default off) is also on. No copy anywhere says so; both helper strings describe behavior that won't happen (`active-app.ts` `allowedByDetectionSettings`).
12. **Progress dashboard** — the skill graph's only entry is a "Progress" button that *only renders when Coach 2.0 is on*; on defaults there is no path to it from anywhere.
13. **Focus Skill loop** — no control anywhere to view, set, change, or pause it; three passive banners.
14. **Objection review queue** — the only path from a mined candidate to a real script lives inside a Settings page.
15. **Prep briefs** — three indirect entrances (edit-an-existing-event button; a deep link only the dead Alerts feature can send; a live-call banner). No list of briefs anywhere. Model Assignment still says prep briefs *"aren't built yet"* — stale by two months.
16. **Practice mode** — an unlabeled "Advisor / Practice" segmented control inside "Ask your coach"; the explanation appears only after switching.
17. **Bookmarks** — the call-detail card is omitted entirely when empty and bookmarks can only be created mid-call: a user who never clipped will never learn it exists.
18. **Custom trackers** ("tell me when someone mentions procurement" — a genuinely differentiating feature) — bottom of Settings → Coaching, whose nav description doesn't mention it; no empty state at all.
19. **Activity Center** — the single home of all background work (including "Needs your review," which holds already-paid-for AI output) is an **unlabeled 40px floating circle**.
20. **Shortcuts** — `?` opens the cheat sheet, and `?` is documented only inside the cheat sheet; on a fresh install the sheet advertises two global hotkeys that aren't registered (detection off). No ⌘1–9, no shortcut hints in the palette.
21. **Settings cross-references are all broken by design** — every "in Settings → X" link in the app lands on Settings → Account (hard-coded `useState('account')`), leaving the user to hunt through 21 items.
22. Cloud backup's six opt-in sync scopes — three are mentioned nowhere else in the product.
23. Reminders on calendar events are silently inert until two-way sync is on (fine print only).
24. **Transcription language is hardcoded `en-US`** (`transcription.ts:220-231`) and undisclosed — while a "Summary language" picker offers dozens of languages.

### 2.4 State of the current empty states

The `EmptyState` primitive exists (13 uses) and the best copy is genuinely good — **Rise's hero is the house standard**: it distinguishes *off* ("switched off right now → turn it on in Settings → Sales Brain") from *broken* ("its database didn't open this session") from *empty* ("import your call history") from *ready* (three starter prompts). Most other screens have only the "nothing yet" state, and one is actively dishonest: **Memory Center with Sales Brain off says "Nothing here yet — facts will show up as calls happen,"** which is false (nothing will ever show up) and prescribes work that cannot help.

---

## 3. Visual identity today (the baseline for Stage 4)

- **Accent:** `#6e7bf2` indigo — the banned hue, by name, in the token file's own comment. Brand mark: `linear-gradient(135deg, accent, #9b6cf2)` — the banned purple gradient.
- **Type:** `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui` — **no font files ship** (zero .woff2 in the repo), so Windows renders Segoe UI and the Inter-specific `font-feature-settings` are no-ops. No mono token exists; transcripts are sans; `font-mono` falls through to Tailwind defaults in 6 places.
- **Type scale: none.** 666 ad-hoc `text-[Npx]` sites across 9 pixel sizes run in parallel with 277 named-scale uses (`text-[14px]` ≡ `text-sm` both in use). The single largest inconsistency in the codebase.
- **Live rendering bug:** four files use tokens that don't exist (`bg-surface-2`, `text-fg-1/2/3`) — Tailwind emits no CSS for them, so the telemetry section and three Home notice cards render partially unstyled today (`TelemetrySection.tsx`, `TelemetryAskCard`, `AccountMigrationNoticeCard`, `AutoUpdateNoticeCard`). Logged as BUG-130.
- **Windows chrome is the weak platform:** macOS gets the seamless `hiddenInset` title bar; **Windows gets a native OS title bar stacked on top of an empty 56px drag strip.** The founder has been using the worst-looking build of their own app. No display-scaling handling: min window 1040×680 is unsatisfiable on 1366×768 at 125–150% scaling (a huge budget-laptop base), and the shell reserves 560px of fixed chrome with no sidebar collapse.
- **Deliberate, keep:** `backdrop-filter` is disabled on Windows behind `.platform-win32` because it renders opaque black on real hardware (documented, empirically verified). **Do not re-enable in the redesign without hardware re-testing.**
- Consent surfaces (modal, chip, recording indicator) are well-crafted and honest. **Untouched by everything in this plan.**

---

## 4. The attention problem (founder-reported 2026-08-29, folded in)

Reported live this morning: opening the app "spams a million notifications" — the Activity Recent list shows walls of *Setting up on-device search / Syncing with the cloud / Backing up to the cloud… / Downloading update / Sales Brain: nightly tidy-up*.

**Mechanism (from code):** the 10-minute heartbeat syncs are already deliberately invisible (`backup.ts:1295-1311` — the comment even predicts this exact wall). But **per-launch maintenance still mints visible entries every single launch**: the on-device search setup job (`nightly-consolidation-job.ts:116`), the sign-in sync (`backup.ts:1282-1293`), update downloads, nightly tidy-up. Job history keeps 500 entries; the Recent list has no grouping or collapsing; so every launch shows days of accumulated identical maintenance rows. **Possible bug on top:** the sign-in sync is documented as "rare — once per sign-in," but Supabase's `SIGNED_IN` event commonly fires on *session restore too*, i.e. potentially every launch — which would contradict the design's own rarity assumption. Logged as **BUG-129** (verify separately; not fixed in this milestone's design pass unless confirmed).

**Proposed policy (Stage 3, needs your approval as part of the IA):**
- Routine maintenance (sync, backup, search indexing, tidy-up, update download) **never toasts and never notifies natively**. It is visible only inside the Activity panel, collapsed into a single "Housekeeping" group row (expandable), not one row per run.
- Completion toasts only for jobs **you started** ("Import finished", "Scan complete").
- Failures always surface — once, quietly (banner/badge), with the fix action attached.
- The Activity button gets a label affordance and "Needs your review" gets its own visible badge state (it holds paid-for AI output).

---

## 5. Stage 0b — Information architecture proposal

### 5.1 The honest diagnosis first

The sidebar is **not** the IA problem — 12 items in 4 labeled groups is defensible. The IA problem is the **policy layer**: features vanish when off, outputs land in invisible places, cross-references don't navigate, and nothing ever announces what exists. A nav redesign alone would repaint the shell the brief warns about. So this proposal is two parts, and **part B is the one that fixes "50%".**

### 5.2 Part A — Navigation: 12 items → 7

| # | Item | Contains | What moved |
|---|---|---|---|
| 1 | **Home** | Today: next meeting + prep brief, start-call CTA, week recap, recent calls, What's New, setup checklist | unchanged position; gains What's New + checklist (Stage 3) |
| 2 | **Rise** | the assistant, unchanged | — |
| 3 | **Calls** | one screen: live session (pinned hero/banner when active) + the saved-call list | **merges Live Calls + Past Calls** — two nav items currently describe one object in two states; the global live pill already exists as the way back |
| 4 | **Pipeline** | Contacts · Deals · Follow-ups · **Tasks** · **Calendar** (sub-nav tabs) | Tasks and Calendar move in — all five answer "who do I owe what, and when"; the Follow-up digest already spans them |
| 5 | **Coaching** | Scorecards · Progress (skill graph) · **Performance (Analytics)** · Practice | **absorbs Analytics** (for a solo rep, coaching *is* the analytics — today the two screens even use the word "skills" for different things) and **absorbs Team/"Your Trend"** (redundant with the Progress dashboard) |
| 6 | **Library** | Knowledge (3 tabs) · **Battlecards** (new browser for the 30 built-ins + custom trackers) · **Objection review queue** (graduates out of Settings) | Settings keeps the *toggles*; the *content workspaces* move to daylight |
| 7 | **Settings** | unchanged, plus deep links | — |

Costs, stated honestly: Tasks and Calendar go one level deeper (mitigated by ⌘K, Home tiles, and ⌘1–7); Analytics loses its top-level slot. **Alternative if you disagree:** keep Analytics top-level and fold Tasks into Pipeline only — still 7. Your call at the checkpoint.

### 5.3 Part B — The discoverability policy (the actual fix)

1. **Visible-off rule.** A feature that's off keeps its surface, rendered as an honest off-state: what it is, one line on what turning it on costs (e.g. "makes real AI calls during the call"), one button. Applies to: Deal Intelligence (live screen + Radar slot on call detail), Coach 2.0 (Progress always visible), Sales Brain (Memory Center honesty fix), Objection Library, CRM Note Generator, Contact Intelligence, Windows noise cancellation on Home. This matches your standing product instinct: smooth default, advertised advanced path.
2. **Tri-state empty standard.** Every empty state must say which of these it is: *nothing here yet* / *switched off* / *needs a key* — each pointing at a different user action. Rise's hero is the template; the `EmptyState` primitive grows these variants. (This is the brief's 3a, grounded in what already works in-house.)
3. **Settings deep links.** `onNavigate('settings')` gains a page argument so every "in Settings → X" link in the product lands on X. Small change, kills a whole class of dead ends.
4. **Fix the trap.** Detection + auto-transcribe become one coherent surface: the sub-toggle states plainly when its master is off, with a jump link. (No behavior change — copy + navigation only.)
5. **Attention policy** — §4 above.
6. **What's New** (brief 3b): one dismissible Home card + palette entry; per release one headline, one visual, one line on why it matters. Kills the "features vanish into the graveyard" problem going forward.
7. **Activation checklist, not a tour** (brief 3c): 3–4 user-initiated items (add Deepgram key → first call → first coach → turn on one AI feature of your choice), skippable, re-enterable from Home; contextual coachmarks fired on action only. No guided tour.
8. **Shortcuts grow up:** palette shows shortcut hints inline; ⌘1–7 switches sections; `?` gets visible entries (palette action + Settings row); the overlay stops advertising unregistered shortcuts.

### 5.4 Out of scope, flagged for your decision (privacy-adjacent — untouchable without you)

- `speakerId.allowSelfIntroExtraction` (buyer speech → third-party LLM) is today written **as a silent side effect** of the Contact Intelligence control, and `voiceProfileMatching` (biometric-adjacent) has no UI at all. Giving these their own honestly-labeled controls would be a privacy *improvement*, but it rewords privacy-relevant surfaces — **not doing anything without your explicit sign-off.** Consent modal/chip/indicator are untouched in every part of this plan.

---

## 6. Stage 0c — Identity: three options, one recommendation

Ground rules honored in all three: **one** accent, under ~5% of any screen; monochrome dark-first ramp with light derived; a UI sans that is not Inter plus a real mono for data/transcripts/metrics; no purple/indigo, no default SaaS blue, no gradient blobs. All three keep the existing token architecture — each is a one-file token swap plus bundled fonts. The `.bg-brand` purple gradient dies in all three, replaced by a flat accent mark. The six speaker colors get re-tuned per ramp.

Competitor colors for distance-checking: Gong = purple; Fathom = blue/teal; Granola = acid lime; Otter = blue; Krisp = mint/teal; Fireflies = dark navy/red; HubSpot (adjacent CRM) = coral-orange.

### Option A — **First Light** ⭐ recommended

- **Accent:** molten amber-gold — dark `oklch(0.79 0.145 72)` ≈ `#F0A63B`; light theme deepens to `oklch(0.58 0.13 66)` ≈ `#A8690E` for AA contrast.
- **Ramp:** warm graphite (near-black with a faint warm cast): canvas ≈ `#100E0A`, surface ≈ `#17140F`, elevated ≈ `#1E1A14`.
- **Type:** **Satoshi** (UI — geometric-humanist, confident, warm) + **Geist Mono** (data, transcripts, metrics, timestamps — excellent tabular figures). Both free for commercial use, self-hosted (our CSP requires bundling anyway).
- **Motion voice:** soft spring, a quiet warm glow on live elements (the live dot, the waveform) — dawn, not disco.
- **One sentence:** *CallRise is first light on a live call — warm, awake, and rising; a coach in your corner, not a dashboard.*
- **Why it wins:** the name is the color story — CallRise / Rise / first light. No competitor can copy it without borrowing our name. A warm accent on a cool-dark base is rare in this category (everyone else is blue/purple/green) and it photographs distinctively in marketing.
- **Honest costs:** (1) semantic *warning* amber sits in the same family — plan: warning shifts to a straw-yellow (`oklch(0.82 0.11 95)`-ish) and the accent is never used as a status color, only interactively; (2) HubSpot's coral-orange is hue-adjacent — ours is gold (hue ~72) vs their coral (~35), and they're a CRM, not a call tool; stated, monitored at the distinctiveness test.

### Option B — **Copper Standard**

- **Accent:** burnished copper — dark `oklch(0.68 0.12 45)` ≈ `#C97E52`; light `oklch(0.52 0.11 42)` ≈ `#8F4E2B`.
- **Ramp:** keep the current cool graphite (it's good), slightly deepened for contrast with the warm metal.
- **Type:** **General Sans** (UI) + **IBM Plex Mono** (data — has real character at small sizes).
- **Motion voice:** precise and instant — machined, no bounce.
- **One sentence:** *Sales is a craft; CallRise is the professional's instrument — warm metal on cool steel, built, not branded.*
- **Why it could win:** copper is the **least-colliding accent possible** (no status system uses it; no competitor owns it); reads premium and serious — the "closer's instrument."
- **Honest costs:** the lowest-energy option — risks reading heritage/quiet rather than live; needs deliberately brighter hover/active states to feel alive during a call.

### Option C — **On Air**

- **Accent:** signal vermilion — dark `oklch(0.66 0.20 32)` ≈ `#F0533A`; light `oklch(0.55 0.19 30)` ≈ `#C13A24`.
- **Ramp:** neutral true near-black: canvas ≈ `#0A0A0B`, surface ≈ `#131316`.
- **Type:** **Geist** (UI) + **JetBrains Mono** (data).
- **Motion voice:** punchy, meter-like — VU meters, hard cuts, the red light snapping on.
- **One sentence:** *A live broadcast console for sales — the red light is on and this moment matters.*
- **Why it could win:** the strongest emotional tie to what the product does (recording, live); the highest energy of the three.
- **Honest costs:** the biggest semantic collision — *danger/error* red must move to a deeper crimson and lean on icons/position, which is real ongoing discipline in a tool full of risk states; Raycast's red-coral is adjacent in dev-tool land.

**My recommendation: Option A.** It's the only one where the identity is derived from the product's own name, it clears every named competitor, and its one real cost (warning-amber separation) has a clean mitigation. B is the safe-and-serious fallback; C is the boldest and the most expensive to keep disciplined.

*(A visual artifact with swatches, mini-mockups, and type samples for all three accompanies this document — fonts approximated where a face isn't on Google Fonts; production always bundles the real files.)*

---

## 7. Stage 0d — The distinctiveness test (built; baseline capture owed)

**Protocol** (run at identity approval as the baseline, and again at end of Stage 4):
1. Capture CallRise's Home and a call-detail screen at 1440×900, dark theme, **logo/brand block cropped out**.
2. Place beside equivalent product screenshots of **Fathom** and **Gong** (the two named competitors) at the same size.
3. Show the shuffled set to 2–3 people who don't use CallRise daily. Ask: *"One of these is CallRise. Which — and how do you know?"*
4. **Pass:** correct identification **plus** a reason that names our identity (the color, the type, the texture) — not layout luck. **Fail → redo Stage 0c.**

**Expected result today: fail.** We render in the Windows system font with the same indigo accent as thousands of AI-generated UIs — that is camouflage, not identity. Baseline screenshots will be captured at Stage 1 start (the app was in live use during this audit; capturing means launching/driving it on your machine, so I didn't).

---

## 8. Revised stage plan (given what exists)

| Stage | Was | Becomes | Size |
|---|---|---|---|
| 1 | Stand up shadcn/Radix/Tailwind v4 + tokens | **Harden what exists:** define the type scale (kill the 666 ad-hoc px sizes), bundle the chosen fonts + `--font-mono` token, fix BUG-130 (undefined tokens), add a real Tooltip primitive, fix the copy-drift list (Appendix B). **Implementation call (mine): keep the 19 custom primitives — no wholesale shadcn migration.** They're solid, adopted, and dependency-free; I'll adopt Radix selectively only where a11y is genuinely hard (menus/popovers/tooltips). Figma MCP + frontend-design skill set up here, with its known dense-UI weakness noted. | S–M |
| 2 | Build sidebar + palette | **Upgrade:** sidebar to the approved 7-item IA (collapse-to-icons included); palette gains shortcut hints, feature-registered commands, settings deep links, ⌘1–7; recent-trail deep-links unified with palette behavior | M |
| 3 | Empty states + What's New + onboarding | **The big one:** tri-state empty standard across every screen, visible-off states for the 13 dark features, What's New, activation checklist, the attention policy (§4), the detection-trap fix | L |
| 4 | Identity pass | Token swap + component sweep + **Windows title-bar overlay** (finally match macOS) + min-size/scaling fixes for 125%/150% + distinctiveness re-test | M |
| 5 | Motion + AI states | Rise already streams with Stop; extend the pattern (coaching chat, summaries), skeletons where missing, spring physics on the new tokens, `prefers-reduced-motion` stays honored | M |

**Rollout guardrails (per the brief's hard constraints):** new identity ships as an opt-in "New look (preview)" appearance setting with one-click revert before it becomes default; IA changes feature-flagged screen-by-screen; nothing removed without a "where it went" pointer; nothing here touches consent surfaces; nothing ships without your per-release authorization.

**Metrics (brief's list, wired through the existing consent-gated telemetry):** `featureOpened` already fires per screen — add palette usage, empty-state-CTA conversions, checklist completion, per-feature first-use. All new events go through the closed signal catalog + scrubber rules from M29 (no content, ever).

---

## Appendix A — Feature inventory (condensed)

*Live-call:* start (5 paths) · control bar (stop/pause/status/latency/waveform) · consent chip + modal + recording indicator + standing consent + capture chime · transcript + interim + jump-to-latest · speaker labels (rename post-call only) · bookmarks · cues (interrupt card + suggestion rail + battlecards + custom trackers + sensitivity) · Ask-the-coach bar · monologue meter · engagement gauge · must-ask checklist + pre-hangup warning · Deal Intelligence HUD (presence/status/nudges/health) · 8 in-call banner types · auto-stop · detection (overlay window, banner, tray, hotkeys) · Tier 1/2 noise cancellation · mic picker + test + diagnostics · call simulator (CLI).

*Post-call:* Past Calls list · call detail (contact link/calendar match/auto-link · summary · transcript search · bookmarks · scorecard + Coach 2.0 blocks + call-type picker + PDF export · coach chat advisor/practice · commitments · radar report · objection test-mining · task generation · attachments · practice flashcards · Sales Brain per-call toggle · Ask Rise) · clipboard brief.

*Intelligence:* Rise (list, streaming chat, citations + evidence modal, tools, learning toggle, voice notes, attachments, client-scoped chats, save-to-brain chips) · Sales Brain (master, interview, backfill import, export, Memory Center, post-call review, silent injection into 6 features) · Knowledge (3 tabs + context-size panel) · Objection Library (mining, scan, heatmap, queue, view-call) · prep briefs.

*Pipeline:* contacts (list, detail, timeline, comments, KYC ~22 fields) · CRM note generator + auto-notes · contact intelligence · deals (board/list, stages editor, detail, risk assessment) · follow-up digest · tasks (buckets, filters, editor) · calendar (month/week, event dialog, reminders, Google/Outlook connect + two-way sync, reconnect nudge).

*Platform:* Home (4 conditional cards, greeting, CTA, week recap, 3 stat tiles, recent calls, audio setup) · Analytics (6 cards + takeaway) · Team → "Your Trend" · Settings (22 pages / 11 groups) · auth (login/signup/OTP) · onboarding (8 steps, replayable, skip=finish) · Activity Center · toasts · native notifications · taskbar progress · quit guard · interrupted-call prompt · live pill · deep link (1 shape) · entitlements scaffold (zero UI, `ENTITLEMENTS_ENFORCED=false`).

## Appendix B — Copy drift & small dishonesties found (Stage 1 fix list)

1. Backup footer says *"never leave this **Mac**"* — shown on Windows (`BackupCard.tsx:299`).
2. macOS virtual mic still user-visibly named **"Sales OS Microphone"** post-rebrand.
3. Model Assignment: *"M19's prep brief feature itself isn't built yet"* — it shipped.
4. Rise's delete-confirm points at *"Settings → Memory Center"* — the page is labelled "Sales Brain — Memories."
5. `settings-nav.ts` detection description says consent rules are "below" — they're on another page.
6. Model Assignment nav description lists 5 jobs; the page has 10.
7. "Team" nav item renders "Your Trend" and explains multi-rep "isn't available yet."
8. Analytics "Coaching skills" (6 rubric dimensions) vs Coach 2.0 "Skills" (8) — one word, two vocabularies.
9. "Deal risk" (CRM, manual) vs "deal health" (live beta) — two systems, no cross-reference.
10. Missing-key banner's dismiss is per-mount — it returns on every visit to Home.
11. Shortcuts overlay advertises ⌘⇧S/⌘⇧P even when unregistered (detection off).
12. Memory Center's false "nothing yet" with Sales Brain off (§2.4).
13. Settings group headers vanish for single-item groups (Recording, Audio, Calendar, CRM float unlabeled).
14. Transcription hardcodes `nova-3` + `en-US`, undisclosed, beside a many-language summary picker.
15. Coaching-detail view drops speaker identities, so quotes attribute differently than on the call page.

## Appendix C — Bugs logged from this audit

- **BUG-129** — launch-time Activity flood / notification spam (founder-reported): per-launch maintenance jobs mint visible entries; ungrouped 500-entry Recent; **verify** whether Supabase `SIGNED_IN` fires on session restore (would make the "once per sign-in" sync job per-launch). Design fix in Stage 3; the trigger question needs its own verification pass.
- **BUG-130** — four files reference nonexistent tokens (`surface-2`, `fg-1/2/3`) → telemetry section + three Home cards render partially unstyled. One-file fix (define tokens or revert names); Stage 1 first commit.

---

*Stage 0 ends here by design. Nothing in this document changes the product. Awaiting: IA approval (§5) and an identity pick (§6).*
