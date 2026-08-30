# Settings — what's actually wrong, and three ways to fix it

**Written 2026-08-29, M31 Stage 4.** Prompted by the founder: *"Maybe after all
the research we can also fix the settings? I think they all look quite messy."*

Same shape as `M31-calendar-research.md`: diagnose first, put real options on the
table, **decide before building**. Nothing in here has been built.

---

## 1. It isn't a taste problem, and that matters

"Messy" is usually a signal that something measurable is off, and here it is. The
numbers below come from `src/renderer/src/features/settings/settings-nav.ts`,
which is the single source of the Settings sidebar.

| | Count |
|---|---|
| Pages visible to a real user | **21** |
| Group headings above them | **10** |
| Total rows in the sidebar | **~31** |
| Rows that fit on the founder's screen | ~22 |

Four specific defects, each independently fixable:

**① Half the groups contain one item.** Recording, Audio, Calendar, CRM, and
Developer are groups of exactly one. A heading above a single row conveys no
grouping at all — it just costs a row and a gap. That's 5 of 10 headings earning
nothing, and it is the single biggest contributor to the list not fitting.

**② One group holds 38% of Settings.** "AI & coaching" has 8 of the 21 pages:
Coaching, Live Deal Intelligence, Summary language, Personalization, Objection
Library, Coach 2.0, Sales Brain, Sales Brain — Memories. When one bucket holds
more than a third of everything, the bucket has stopped sorting. There is also no
user-facing model that separates "Coaching" from "Coach 2.0" from "Live Deal
Intelligence" — you have to already know the roadmap.

**③ You can never see the whole list.** At ~31 rows the sidebar always scrolls.
In the founder's own screenshot, "Audio" is clipped at the top and "Job
Inspector" at the bottom — so at no point can you build a mental map of what
Settings contains. Every visit is a search rather than a recall.

**④ Six pages are named from the inside out.** "Model Assignment", "Contacts &
matching", "Live Deal Intelligence", "Diagnostics & telemetry", "Sales Brain —
Memories", "Job Inspector". These name the implementation, not the thing the user
came to do. (This is the same defect the Stage 0 audit found in the main nav, and
the same one the approved 12→7 IA fixed.)

And one that is arguably a bug rather than a layout problem: **Sales Brain is one
concept occupying two nav rows** (the feature and its memory browser), as are
App and Appearance.

---

## 2. What this is NOT

Worth stating so the options below don't quietly grow:

- **Not a settings *content* problem.** The individual pages are fine. Nothing
  here proposes changing what any setting does, or removing any setting.
- **Not a colour problem.** Settings inherits First Light like every other
  screen; the screenshot that prompted this already has the new palette. Making
  it prettier would not make it findable.
- **Not the main nav.** That IA is already approved and shipped behind
  `navigationPreview`. This is the *inside* of Settings, which that work did not
  touch.

---

## 3. Three options

### Option A — Collapse the singletons (small, ~half a day)

Delete the 5 headings that sit above one item and fold those items into their
nearest real neighbour. No page is renamed, no page moves group, nothing is
removed.

- Rows: 31 → **26**. Still scrolls, but less.
- Risk: essentially zero. Purely subtractive chrome.
- What it does **not** fix: the 8-item bucket, the naming, the scrolling.

*This is the floor. Every other option includes it.*

### Option B — Re-group to 5 headings, rename 6 pages (medium, ~2 days) ← recommended

Rebuild the grouping around **what you're trying to do**, not which subsystem
owns it, and rename the six inside-out pages. Concretely:

| Group | Pages |
|---|---|
| *(no heading)* | Account |
| **Calls** | Recording & consent · Call detection · Notes & summaries¹ · Audio |
| **Coaching** | Live coaching · Skills & goals² · Objection library |
| **Your AI** | Providers & keys³ · Which model does what⁴ · About you⁵ · What CallRise remembers⁶ |
| **Connections** | Calendar · Contacts |
| **App** | Appearance · General · Privacy & data · Diagnostics |

¹ was "AI Note Taker" + "Summary language" merged · ² was "Coach 2.0" +
"Coaching" sensitivity · ³ was "API keys" · ⁴ was "Model Assignment" ·
⁵ was "Personalization" · ⁶ was "Sales Brain" + "Sales Brain — Memories" merged

- Rows: 31 → **21**, which **fits on one screen with no scrolling**.
- Pages: 21 → 17 (four merges, zero deletions — every setting survives).
- Risk: moderate. Deep links and any saved position need a redirect map, exactly
  like the main-nav work. Every old id keeps working.
- Fixes all four defects.

### Option C — Search-first (larger, ~4 days)

Keep a short pinned list and make **⌘K search the primary way in** — type
"noise" and land on the audio page, type "delete my data" and land on Privacy.
This is what Slack, Linear and macOS System Settings all converged on.

- Fixes findability at any size, permanently — Settings can keep growing.
- Risk: higher. Needs every setting indexed with real synonyms, and a search
  that returns nothing is worse than a list.
- Honest read: this is the right *end state*, but it is worth more **after** B
  than instead of it. A search box over a badly-grouped list still leaves the
  list badly grouped for anyone who browses.

---

## 4. Recommendation

**B, preview-flagged like the other two, with C as a later stage.**

B is the option that changes the answer to "can I see everything Settings does
in one look?" from no to yes, and it's the same move already approved for the
main nav — so it's consistent rather than a second philosophy. A is included in
B for free. C is a real improvement but it's an addition, not a replacement, and
doing it first would paper over ②.

Two things I'd hold B to, matching the main-nav rules already agreed:

1. **Nothing removed.** Four merges, and every merged page keeps a visible
   heading inside its new home so "where did it go" always has an answer.
2. **Every old deep link keeps working**, pinned by a test that walks all 21
   current ids — not by inspection.

---

## 5. Open questions for the founder

1. **A, B, or C?** (Recommendation: B.)
2. **The six renames** — are they yours to approve one by one, or is "make them
   say what the user is trying to do" enough of a brief? The names above are a
   proposal, not a decision.
3. **The four merges** specifically: Note Taker + Summary language, Coaching +
   Coach 2.0, Sales Brain + its memories. Each is one concept in two rows today,
   but if any of those pairs is deliberately separate, say so and it stays split.
4. **Does "Developer / Job Inspector" stay dev-only?** It is today
   (`import.meta.env.DEV`), so real users never see it — the row only exists in
   the founder's own build. Nothing to fix if that's intended.
