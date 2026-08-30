# M31 — Calendar design research

**Date:** 2026-08-29 · **Status: RESEARCH ONLY — nothing here is built.** Requested by
the founder after BUG-135 (past calls removed from the calendar) as the grounding
pass before Stage 4 touches the calendar surface. Per the request: research →
proposal → founder reads it → then, and only then, code.

Method: five parallel research passes (Notion Calendar/Cron, Amie, Fantastical,
the AI-schedulers Reclaim/Motion/Clockwise, and Google/Outlook conventions), each
against real primary sources — the products' own docs and changelogs, App Store
listings, archived marketing pages, HN/press coverage — plus a read of our own
calendar code (`CalendarView.tsx`, `MonthGrid.tsx`, `WeekGrid.tsx`, `items.ts`,
`EventDialog.tsx`, `usePrepBrief`/`PrepBriefCard`, `staleness.ts`). Findings below
cite sources; where a claim couldn't be verified, it says so instead of pretending.

---

## 0. Where our calendar actually stands today (so the gaps are measured, not felt)

What we have, post-BUG-135:

- **Views:** Month (default) and Week. No Day view, no agenda/list view.
- **Month:** fixed 6-week grid, **3 visible chips per day**, then "+N more" opening
  a peek popover. Chips: time + title, colored per kind.
- **Week:** 24h grid at 44px/hour, real side-by-side lane packing for overlaps
  (`layoutColumns` — same algorithm family as Google), an accent-colored live
  now-line with auto-scroll-to-now on open, an all-day row, click-an-hour-to-create.
  Genuinely decent bones — this file is not the problem.
- **Creation:** click empty slot → full modal dialog (title, dates/times, all-day,
  notes, linked contact, linked deal, reminder chips, prep-brief button on edit).
  No quick-create popover, no drag-to-create a range, no drag-to-move/resize, no
  natural-language input.
- **Color:** one color per *kind* (local event / task / Google / Outlook), not per
  calendar or per anything meaningful to a rep. Legend dots are not clickable.
- **Unconnected state:** two full-width "Connect Google / Connect Outlook" cards
  permanently occupy the top of the screen, connected or not (they shrink but
  never leave).
- **Sales-native data already wired in** (this matters for §5): events carry
  `contactId`/`dealId`; per-event **prep briefs** are cached and openable from the
  event dialog; deals have live **attention tiers** (risk-high / risk-medium /
  risk-stale / stale) powering the Follow-ups digest; Google/Outlook `attendees`
  feed CRM calendar-matching; `callrise://meeting/<id>` deep links open a
  meeting's brief; reminders push to Google/Outlook as real notifications.
- **Known honesty gap** (audit item #23): reminders are silently inert until
  two-way sync is on — fine print only.

---

## 1. What each app does well — specifics, not adjectives

### Notion Calendar (Cron)

The most conventional of the modern set, and deliberately so — HN's recurring
verdict is that it *reuses time-proven calendar conventions* and wins on keyboard
depth and polish rather than novel layout.

- **Density = zoom, not overflow.** Two orthogonal levers: "Zoom Hours In/Out"
  compresses the vertical hour grid, and number keys **1–9** set how many day
  columns are visible (a Cron original: "set number of displayed days," 2021
  changelog). All-day events get a **collapsible strip** so they can't eat the
  timed grid. No "+N more" anywhere, because the primary surface is a time grid,
  not a month of boxes. *(Sources: notion.com/help/notion-calendar-settings,
  cron.com/changelog.)*
- **Default view: Week** — stated plainly in Cron's changelog ("defaults to a week
  view"); Day/Week shipped first, Month added a year later as the third option.
- **First run:** immediately prompts to connect an account (Google/Outlook/iCloud
  OAuth), then a setup wizard docks in the right side panel — connect more
  accounts, enable notifications, link Notion. The app never shows a
  permanent "connect" billboard; connecting *is* the onboarding, once.
- **Color:** auto-assigned per calendar with collision avoidance; Cron documented
  using **CIECAM02 color-space transforms** to keep the same palette legible in
  dark and light mode (2021-06-28 changelog — an unusually rigorous detail worth
  remembering for First Light's own ramp work).
- **Keyboard grammar:** `C` create, `T` today, `D/W/M` views, `1–9` day count,
  `Cmd+K` palette (create, jump-to-date, search, toggle calendars). A calendar
  that expects to be driven from the keyboard.
- **De-dup across accounts is identity-based** (same event ID merges), not fuzzy.
- The July 2025 "better colors, icons, legibility" refresh has no public specifics
  beyond that phrase — verified as the actual documentation ceiling, not a
  research miss.

### Amie

The task/event blender. One caveat up front: Amie has since repositioned around
AI meeting notes, so its calendar reputation is a 2022–2024 artifact — still real,
but not where their investment goes now.

- **Tasks and events share one block shape.** No separate lane, no different
  geometry. The at-a-glance differentiator is **an icon inside the block**: tasks
  keep their checkbox on the calendar block itself (clickable to complete);
  meetings show attendee avatars + a join-video icon. *(App Store screenshots;
  archived marketing site.)*
- **Drag-to-schedule:** unscheduled todos live in a side panel; dragging one over
  the grid shows a **dashed-outline placeholder reading "Release to schedule."**
  Works in month view too (changelog #109).
- **Auto-scheduling exists but is opt-in per task** (priority/deadline set → the
  AI places and re-places it, with a default 15-min gap between blocks).
- **Density escape valve is a separate agenda/list view** (added Sept 2024,
  changelog #116) — not in-grid compression.
- **Color is per-calendar only** (their palette literally pinned to Google's own
  8→11 calendar colors), with a stated restraint principle from their design
  story: "having small touches of color makes it more colorful than having the
  whole thing in color."
- **Default view: Week**, with one genuinely clever variant — the week can
  **left-align on *today*** instead of a fixed Monday/Sunday start (changelog
  #109), so the visible range is always "now + the next six days."
- **First run is quiet, not empty:** the fresh grid ships with a default holidays
  calendar and week-number banners, so the canvas never looks dead; empty lists
  say just "Nothing in here."

### Fantastical

The reference for input speed. Two Apple awards, and in both cases Apple named
the same mechanism: describing an event in words and watching it assemble.

- **The parser** handles dates/times/durations/ranges ("tomorrow at 5 for 30
  minutes"), time zones, locations ("at Joe's"), invitees ("with" + contact
  autocomplete), alerts ("alert 30 minutes"), full recurrence grammar ("third
  Thursday of every month"), and **calendar assignment via slash syntax**
  (`/w` → Work). Quotation marks escape text the parser would eat. *(Flexibits
  help: Adding Events and Tasks; The Sweet Setup's NL guide.)*
- **The famous live preview:** as you type, an event panel assembles itself in
  real time — recognized words highlight and fill the matching fields, and
  autocomplete popovers appear when it detects a probable person/place/calendar.
  Flexibits' own framing: "you can watch the action being teed up… a helpful way
  to make sure you and the computer are on the same page." The preview IS the
  trust mechanism.
- **The zero-click path is the real product:** a global hotkey (Ctrl-Opt-Space)
  opens a menu-bar mini window with keyboard focus **already in the parser
  field** — type, Enter, back to work. MacStories has repeatedly identified this
  loop, not the grid, as why it wins.
- **It's proprietary and deliberately not an LLM** — an on-device rules+ML
  engine begun as a college project; Flexibits: it "does not do any predicting
  or contextual guessing like an LLM would." The open-source landscape covers
  only the date half: **chrono-node** (the de facto JS standard, dates/ranges
  only), **Sherlock** (closest to the full trick — title+start+end from a plain
  sentence — but aging and US-English-centric), Microsoft Recognizers-Text
  (solid JS date/time recognizers). Everything around the date — title
  extraction, "with"-invitees, disambiguation quality — is the hard,
  unpackaged part.
- **Where even the best parser fails, documented at length** (MacRumors
  thread): colleagues named **April and May** constantly re-dating events
  ("Ring May for update" → scheduled in May), "action point 7.20" → July 20,
  title words silently eaten. The failure mode is **over-parsing** — and
  Flexibits refuses to let users disable it. Worth remembering: the cost of NL
  input is a new class of silent misfire.
- **Density:** the sidebar list+grid hybrid is itself the density answer — the
  chronological list always shows the complete agenda, so the grid can afford
  to truncate; month cells expand **in place** on "more…" (no navigation);
  month view is configurable 2–8 weeks per screen.
- Factory default view: genuinely undocumented (its canonical desktop
  presentation is sidebar + month, but no source states the first-launch
  default).

### Reclaim / Motion / Clockwise — the AI-time visual language

Context that reframes this whole category: **Clockwise no longer exists** — a
Salesforce acqui-hire killed the product on March 27, 2026; Smart Holds were
deleted from users' calendars and the KB is offline. Its patterns below are
archaeology (quick-start PDF, indexed KB snippets, press), and its death is
itself a data point about betting a product on AI-managed time.

- **Two visual dialects, set by who owns the canvas.** Reclaim and Clockwise
  lived *inside* Google/Outlook, so their entire language is what a calendar
  API can control: **title-prefix glyphs + event color + free/busy state**
  (Reclaim: 🆓 flexible/dotted vs 🛡️ defended/solid vs 🔒 locked; Clockwise:
  the ❇️ sparkle = "this meeting may move"). Motion owns its calendar surface
  and uses **block styling instead**: auto-scheduled tasks render **gray**
  (a muted third class next to real meetings), "ghost" not-yet-active tasks get
  a dotted border and lighter fill, AI-generated tasks carry a ✨ badge, locked
  ones a 🔒.
- **All three converge on one lifecycle grammar:** movable state is marked on
  the block (dotted/lighter/sparkle) → **any manual touch = pin** (Reclaim
  auto-locks on drag; Clockwise swapped ❇️ for ⏸; Motion turns a dragged task
  into a fixed 🔒 placement) → pinned state is marked with a lock-family glyph.
  The user's gesture IS the override; no separate "approve/decline" ceremony on
  the block itself.
- **Trust mechanics beat visual mechanics.** Clockwise's most-praised design
  decision wasn't a glyph — it was policy: moves batched once daily, "up to 4pm
  the day before," and **never same-day**. Reclaim's docs pre-empt the
  wall-of-busy complaint by keeping AI blocks marked *free* to others until
  slack runs out. Motion documents that meetings are fixed and only tasks move.
- **The complaint literature is about behavior, not rendering.** Documented
  complaints: Motion "packs the day too tightly… oppressive," reshuffles "in
  ways that don't feel discerning"; Clockwise's moves surprised *other people*
  and its notification emails "didn't have any real impact" (the changelog
  itself became noise); Reclaim is "more sophisticated than intuitive"
  settings-wise. **No sourced complaint says "I can't tell what's real"** — the
  glyph/ghost conventions evidently work; what fails is over-eager movement and
  silent density.

### Google Calendar / Outlook — the conventions our users already have

Not inspiration; the baseline of expectations. The inventory that matters to us:

- **Overflow is unsolved there too.** Google's month view shows what fits, then
  "+N more" opening an in-place overlay; there is **no setting to show more**
  (a perennial complaint thread). New Outlook likewise: fixed rows, a "+N"
  chip, and Microsoft answers saying it's "limited by the product design."
  Their real escape valves are elsewhere — Google's Schedule view and
  Comfortable/Compact density setting; Outlook's right-hand My Day agenda pane.
  Our 3-chips-plus-peek-popover month is already at parity with both.
- **Week/day overlap:** both render concurrent events side-by-side with split
  widths (Google's algorithm is a well-known reconstruction: overlap groups →
  first-fit columns → equal widths). **Ours already does exactly this**
  (`layoutColumns`).
- **Default views:** Google documents only *stickiness* — "after you choose a
  new view, it becomes your default." Outlook has **no default-view setting at
  all**, and OWA users repeatedly report it reopening in Month. First-run
  defaults are officially undocumented for both. No published usage statistics
  exist for either product (verified absence, not a search failure).
- **Event visual grammar** (whose convention is whose):
  - *Both:* **solid fill = accepted/yours; outlined/dashed = unconfirmed.**
    Google renders unanswered invites as lighter outlined chips; new Outlook
    puts a dashed border on not-yet-accepted items (confirmed by MS support as
    intended design). Note the collision risk with §2.4's AI grammar — dashed
    means "tentative invite" to a Google/Outlook native. We don't render RSVP
    state today, so the lane is clear for now, but if we ever do, the two
    meanings need distinct treatments.
  - *Google month view:* timed events are **dot + start time + title text**;
    solid bars are reserved for all-day/multi-day. (Ours renders everything as
    a filled chip — heavier than the convention our users see all day.)
  - *Outlook:* the colored **left-edge bar** + Show As states (Busy solid,
    Tentative hatched, **OOO always purple**, Working Elsewhere dotted).
    Left-edge accent is an Outlook signature — our week blocks already use a
    `border-l-2`, comfortably familiar.
  - *Declined:* opposite conventions — Google keeps them (struck through,
    toggleable); Outlook removes them by default.
- **Creation flow:** both use click-empty-slot → **compact quick-create card**
  (title + time pre-filled) with drag-to-create-a-range, "More options" for the
  full editor. And notably: **Google's title field parses natural language
  today** — its own help's example is typing "Tennis practice at 5pm" (dates,
  times, durations only; no recurrence/attendees). Classic Outlook's AutoDate
  parsed "next Tuesday" in date fields; **new Outlook dropped it**. So light NL
  in a quick-create field is a *Google-user expectation*, not an exotic
  power feature.
- **Now/today marking:** Google = red now-line + filled accent circle on
  today's date; Outlook = blue line, famously too-subtle today highlight. Ours
  (accent-colored line + filled accent circle) is already inside convention.

---

## 2. The six questions, answered

### 2.1 Density — how the best handle an 8+ item day

The honest headline: **nobody solves month-view density — the best apps route
around it.** Google and Outlook both hard-cap month cells and offer "+N more"
with no setting to change it. The design-leader apps avoid the problem by not
living in Month: Cron's answer is a week/day **time grid with two zoom axes**
(hour-height zoom + 1–9 visible-day count) where overflow is structurally
impossible; Fantastical's answer is the **list+grid hybrid** — a chronological
sidebar list always shows the complete agenda, so the grid is allowed to
truncate; Amie added a dedicated **agenda/list view** as its escape valve.
Within week grids, everyone (including us, already) does side-by-side lane
packing.

For us the pressure also just dropped an order of magnitude: BUG-135 removed
the per-call flood that produced "+22 more." What remains on a rep's calendar —
meetings, due tasks, synced events — is the volume these mechanisms were built
for. Our month peek-popover is at parity with Google's own overlay; the real
density gap is that we have **no complete-agenda surface at all**: no Day view,
no list. The fix is one addition (an agenda rail or view — see §3), not a
month-grid engineering project.

### 2.2 The default view

What the evidence actually says:

- **Nobody publishes usage data.** Verified absence — no vendor stats or
  credible research on which views people use, for any product researched.
- **The products designed this decade chose Week.** Cron's changelog states it
  plainly ("defaults to a week view" — Day/Week shipped first, Month came a
  year later as the third option). Amie triangulates to Week from every
  screenshot, its marketing hero, and week-specific features. Fantastical's
  first-launch default is undocumented, but its signature layout keeps a
  complete agenda list beside whatever grid is showing.
- **The incumbents don't defend Month either.** Google's documented model is
  stickiness (your last choice wins), not a Month default; Outlook web lands in
  Month mostly by inertia, and it's the one users file complaints around.
- **The task fit:** a sales rep's calendar questions are "what's next, am I
  prepared, where are the gaps" — hour-resolution questions. Month answers
  "which day is the offsite," a real but secondary question. Month is also the
  view where our density ceiling and BUG-135's clutter lived; Week is the view
  where our best code already is (lane packing, now-line, auto-scroll-to-now).

**Recommendation:** default to **Week**, keep Month one click away, and adopt
Google's stickiness (remember the last-used view — a few lines of
localStorage). Amie's "week starts today" rolling variant is genuinely clever
but non-conventional; noted as a later option, not part of the proposal.

### 2.3 Natural-language input

**What it buys:** input speed and — per Apple's own award citations, twice — the
single most-loved calendar interaction of the past decade. For a rep logging
follow-ups between calls, "call Ben Tuesday 2pm /follow-up" beating a
five-field modal is real.

**How hard it is:** the date/time half is a solved, free problem — chrono-node
parses "next Tuesday at 2pm for 30 minutes" today and is the de facto JS
standard. The half that made Fantastical famous — title extraction, invitee
matching, the live assembling preview, and above all *disambiguation quality* —
is proprietary, un-packaged, and where the documented failure modes live
(colleagues named April/May re-dating events; "action point 7.20" → July 20).
Fantastical ships an over-parser you can't turn off; we should not sign up to
build or maintain one.

**Does it fit a ⌘K-first app:** yes — and that's the answer. Notion Calendar
already demonstrates the pattern: event creation lives in its ⌘K palette
alongside jump-to-date and search, not in a dedicated parser field. We already
have the palette, it already has entity search, and Stage 2 just taught every
action in it to show its shortcut.

**Recommendation (see §3):** a "New event…" palette action whose one text field
runs **chrono-node for the date/time part only**, with a Fantastical-style live
preview line showing what was understood ("→ Tuesday, Sep 2, 2:00–2:30 PM"),
and everything unparsed becoming the title verbatim. Contact linking stays a
picker (our contact list is exactly the April/May trap — sales contacts are
*named people*, the single worst input for fuzzy NL matching). No invitee
grammar, no slash syntax, no recurrence grammar in v1. The preview line is
non-negotiable — it's the trust mechanism that makes parser mistakes visible
before they're saved, which is the precise thing the Fantastical complaint
threads say is missing.

### 2.4 AI-time visualization

The question was how to show "this block is AI-suggested/managed" without noise
or a sense that the app took over. The industry has converged hard enough that
this is nearly settled grammar:

1. **AI-flexible = dotted border + lighter/ghost fill.** Motion's ghost tasks,
   Reclaim's dotted 🆓 state, Amie's dashed "Release to schedule" drop target —
   three independent products, same signal. Dotted/ghosted reads as
   "provisional" without a legend.
2. **A single small badge on the block, not a color.** Motion's ✨ for
   AI-generated items is the cleanest precedent (and we already use the
   Sparkles icon for exactly this meaning — the prep-brief button, Rise). Color
   should keep meaning *what* the block is (meeting/task), not *who made it* —
   Motion needing gray as a whole third color class is a cost of being a
   scheduler, not a pattern to copy.
3. **User touch = pin, visibly.** Every product converges on it: drag or edit
   an AI block and it locks, and the state change is shown on the block
   (🔒/⏸). If we ever place AI time, this is mandatory — it's the "the app
   didn't take over" guarantee.
4. **The real trust levers are behavioral, not visual:** never move things
   same-day (Clockwise's most-praised policy), never mark AI time busy-to-
   others while it's still provisional (Reclaim), and don't emit a
   notification per move (the Clockwise complaint). The complaint record shows
   users never struggled to *see* AI time — they hated it moving too much and
   packing too densely.

**Relevance to us, stated precisely:** we do not auto-schedule anything today,
and nothing in this proposal starts. Where this grammar applies *now* is
smaller: AI-**suggested** items (a follow-up task extracted from a call and due
on a day; a suggested prep slot before a risky meeting, if that ever ships) get
dotted-border + ✨-badge treatment and become solid on user confirmation. The
full movable/locked lifecycle only matters if we ever build placement — flagged
in §4 as a product decision, not assumed.

### 2.5 What a sales rep needs that a generic calendar can't do

This is the differentiation question, and it's answerable from our own code
today — every capability below already exists in the data model and needs **zero
new backend**:

1. **Every meeting already knows who it's with and which deal it's on.**
   `CalendarEvent.contactId`/`dealId` exist and are set via the event dialog and
   calendar-matching. Cron renders "Design review, 2pm." We can render "Ben —
   Super Fund deal, Proposal stage, risk: medium, last call 6 days ago." No
   generic calendar can, because none of them know what a deal is.
2. **Prep-readiness is a real, checkable state.** Briefs are cached per event id
   (`usePrepBrief`). The calendar can show *which upcoming meetings have a brief
   ready vs. not* — a glanceable "am I prepared for tomorrow" signal that is
   literally impossible in Google/Outlook/Cron. Today the brief is only reachable
   by opening the event's edit dialog and noticing a button.
3. **Deal urgency can color time.** `dealAttentionTier()` already ranks every
   open deal (risk-high → stale). A meeting on a high-risk deal is not the same
   object as a coffee chat, and the calendar is the one surface where "what's my
   week" and "which deals are on fire" could be the same picture.
4. **The gap between meetings is sales-native space.** We know commitments owed
   (open commitments live in the brief data), follow-ups due (Tasks with
   `dueAt`), and stale deals. Generic calendars sell "focus time"; ours could
   honestly mark "you have 40 free minutes and three overdue follow-ups."
   *(Flagged in §4 as a product decision — this is AI-adjacent time placement
   and needs the AI-time visual language from §2.4 before it exists at all.)*
5. **The meeting's aftermath is linkable.** Post-meeting, the matched call, its
   summary, and its scorecard exist in the same app. A past meeting on our
   calendar could open what *happened*, not what was *planned* — the one
   defensible version of BUG-135's removed calls-on-calendar idea (the plan and
   its outcome joined on ONE chip, rather than two unrelated chips flooding the
   grid).

What this list is **not**: a license to build five features. It's the menu the
proposal in §3 picks from, and the reason the proposal keeps the grid itself
boring and conventional — the differentiation budget goes into what the blocks
*know*, not into a novel grid.

### 2.6 The empty/unconnected state

What the researched apps do before anything is connected:

- **Notion Calendar:** connecting *is* the onboarding — first launch
  immediately prompts the OAuth connect, then a **setup wizard docks in the
  right side panel** (more accounts, notifications, Notion link) and goes away.
  There is no permanent connect billboard anywhere in the product.
- **Amie:** "quiet, not empty" — a fresh grid ships pre-populated with a
  holidays calendar and week-number banners so the canvas never looks dead;
  empty lists get two words ("Nothing in here"), no CTA cards.
- **Google/Outlook:** the question barely exists (the account *is* the
  calendar), but their convention for auxiliary panes is the same: transient
  prompts, never permanent real estate.

Ours inverts all of this: two full-width connect cards permanently occupy the
top of the screen **whether or not you're connected**, pushing the actual
calendar down — the only surface in the app that spends its best pixels on
plumbing. And our calendar is never actually useless unconnected: local events,
tasks, reminders, prep briefs all work without Google/Outlook.

**Recommendation (per the founder's instruction, folded in here rather than
done as a one-off):** the two cards leave the calendar body entirely.
Connected state → a small header affordance (provider dot + last-synced +
refresh, roughly what the cards' connected form already shows, in one line).
Unconnected state → one compact dismissible banner row ("Connect Google or
Outlook to see your real meetings here — Connect") plus a permanent low-key
entry point in the header and Settings → Calendar, so dismissing the banner
never strands the feature (the audit's visible-off rule). First-run keeps the
tri-state empty standard: the grid renders, one line explains what shows up
here and that clicking any day creates an event.

---

## 3. Proposal

Design stance in one sentence: **keep the grid boring and conventional
(Google/Outlook muscle memory is an asset), and spend the entire
differentiation budget on what the blocks *know*** — contact, deal, risk,
prep-readiness — because that's the axis where Cron structurally cannot follow.

### 3.1 Adopt — ranked

1. **Default to Week; remember the last-used view.** Evidence-backed (§2.2),
   nearly free, and moves daily life onto our best-engineered view. Month
   stays one click away.
2. **Kill the connect billboards** (§2.6): header affordance + dismissible
   banner + Settings entry. The calendar's first screenful becomes the
   calendar.
3. **Sales-native event chips** — the differentiator (§2.5). On any event
   linked to a contact/deal, the block/chip carries: contact name, and in Week
   view (where blocks have height) a second line with deal stage; a small
   **risk tint or corner marker** when the linked deal's attention tier is
   risk-high/medium (colors deferred to First Light — structure now, values at
   Stage 4); and a **prep-brief state dot** (ready / none yet) that opens the
   brief directly from the block — one click, not
   block → edit dialog → button. This is capability #1–#3 from §2.5, all from
   existing data.
4. **"New event" in ⌘K with light natural-language dates** (§2.3):
   chrono-node for date/time only, everything unparsed becomes the title, a
   live preview line showing the parse before Enter. Matches Google's own
   quick-add convention, avoids Fantastical's over-parsing trap, and lands in
   the palette Stage 2 just finished teaching shortcuts to. The same parse
   also goes into the existing dialog's title field (type "Ben follow-up
   Tuesday 2pm", watch the date fields fill).
5. **Quick-create card on empty-slot click** instead of the full modal
   (Google/Outlook convention): title + parsed time + "More options" opening
   today's dialog. Drag-to-create a range in Week view rides along.
6. **An Agenda rail** (Fantastical's list+grid lesson, Outlook's My Day): a
   right-hand chronological list of the visible range — complete, never
   truncated, each row showing the same contact/deal/prep context. This is the
   density escape valve (§2.1) and doubles as the "am I prepared for this
   week" scan surface.
7. **AI-suggested items grammar** (§2.4), only where suggestions already
   exist: dotted border + ✨ badge for AI-proposed follow-up tasks shown on
   their due day; solid on confirm. No auto-placement of anything (see §4.2).

### 3.2 Deliberately not adopting

- **A Fantastical-class NL parser** (invitees, locations, recurrence grammar,
  slash syntax): proprietary-grade effort, and its documented failure mode
  (over-parsing names like April/May — our contact list is made of names) is
  aimed straight at us.
- **Auto-scheduling / AI time placement** (Motion/Reclaim territory): the
  complaint literature is damning (over-packing, non-consensual moves), the
  category's poster child just got shut down, and it's a product bet, not a
  design fix. §4.2 if ever.
- **Month-view density engineering**: nobody solves it; Google/Outlook
  shipped the same cap we have. Week-default + Agenda rail dissolve the
  problem instead.
- **Hour-zoom and 1–9 day-count controls** (Cron): real power features, wrong
  decade of our product's life. Revisit on demand.
- **Task time-blocking / drag-tasks-onto-the-grid** (Amie): tasks today have
  a due *day*, not a scheduled hour — dragging one to 2pm silently invents a
  new data model. §4.3 flags it as the product decision it is.
- **A second visual identity for the calendar**: it inherits First Light like
  every other screen; no calendar-specific palette.

### 3.3 Sequencing (respecting "the calendar is a Stage 4 surface")

- **Slice A — structure (no identity dependency):** default-Week +
  stickiness, connect-card removal, quick-create card, ⌘K event creation with
  parse preview. Nothing here touches color ramps; it could land before or
  alongside Stage 4 — founder's call on timing.
- **Slice B — the sales layer:** chip context (contact/deal/prep dot), Agenda
  rail, risk markers. Structure can precede Stage 4 but its *colors* (risk
  tint, prep dot, chip weights) land with First Light so they're chosen once,
  against the real ramp, under BUG-133's contrast guard.
- **Slice C — AI-suggested grammar:** with or after B, gated on §4.2.
- Each slice behind the same preview/revert discipline as Stage 2 where it
  changes existing behavior (the view default and the connect-card removal are
  the two behavior changes; the rest is additive).

---

## 4. Product decisions flagged for the founder (design can't settle these)

1. **Should a past meeting's chip open what *happened*?** §2.5.5: joining a
   calendar event to its matched call (summary, scorecard) would be the
   defensible version of the removed calls-on-calendar — the plan and its
   outcome as one object. It reintroduces "calls on the calendar" in
   controlled form, right after you had me remove them — so it's explicitly
   yours to want or veto.
2. **Do we ever *place* AI time** (suggested prep slots before risky
   meetings, follow-up blocks in gaps)? Everything in §2.4 says: if yes, only
   with the dotted/✨/touch-to-pin grammar, never-same-day moves, and
   suggestions-not-placements by default. But whether CallRise schedules
   anything at all is a product bet, not a design call.
3. **Should tasks become time-blockable** (a scheduled hour, not just a due
   day)? Changes the task data model and Tasks-page semantics; Amie shows the
   interaction pattern works, but it's new product surface.
4. **Reminder honesty** (audit item #23): reminders on events are silently
   inert until two-way sync is on — fine print only. Fix is cheap (state it
   on the picker + offer in-app notification fallback), but whether CallRise
   fires its own event notifications when unsynced is a small product
   decision.
5. **The "week starts today" rolling view** (Amie): unconventional but
   arguably the correct week for a rep. Off by default if ever built; listed
   because it's cheap to add behind the same view switcher.

---

*Research passes: Notion Calendar/Cron, Amie, Fantastical, Reclaim/Motion/
Clockwise, Google/Outlook — 2026-08-29. Source URLs live in the underlying
research notes; every claim above marked "documented"/"verbatim" traces to a
primary source, and gaps are stated as gaps.*
