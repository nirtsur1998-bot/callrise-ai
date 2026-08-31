# M32 Stage 2 — Outcome tracking

**Built 2026-08-31.** Branch `claude/m32-stage2-outcomes`, commit `25f77d8`.
Full suite 309 files / 3108 tests, exit 0. Typecheck clean.

---

## The number that governs everything: 8 in EACH arm

**Not 16 between them.** A 20-and-2 split is 2.

The binding constraint is almost always the *lost* arm, so the closed deals
actually required scale with the win rate:

| Win rate | Closed deals needed to reach 8 lost |
|---|---|
| 50% | 16 |
| 60% | 20 |
| 70% | 27 |

Today: **4 won, 0 lost.** The backfill covers **15 contacts** — corrected from
the 19 in the scope doc after rendering the real list: 19 counted contacts with
at least one coached call, and the backfill excludes contacts who already have
a deal. Even a perfect backfill will not reach the bar on its own — that was
measured before it was built, and the counter says so on screen rather than
implying an arrival date.

The flow reads its count from state (`{answered} of {total}`), so it says 15
without anyone maintaining a number. This doc and the scope doc are the copies
that had to be corrected by hand — which is the usual direction of that bug.

`MIN_PER_ARM = 8` is labelled in the source as a **judgment, not a
derivation.** Pretending otherwise is the exact dishonesty this stage guards
against.

---

## What was built

### 1. The gate — `src/main/deal-outcomes.ts`

Pure logic, no Electron, no filesystem. `Insight` is a discriminated union:

```
insufficient  → counts, usable totals, needPerArm, bindingArm, backfillUntrustworthy
ready         → counts, usable totals
```

The `insufficient` arm carries **no analysis output at all** — no effect size,
no direction, no percentage, not a hint of one. *A caveat next to a number gets
read as a number*, so at low N the number must not exist for a renderer to
find. `deal-outcomes.test.ts` enumerates that arm's keys, so a new field
slipping onto it fails.

`evaluateGate` is the only exported path to a `ready` insight.
`deal-union-lockstep.test.ts` walks the whole `src` tree and fails if any other
file constructs one or re-derives the bar. It enumerates the *container*, not a
list of filenames — a filename test cannot fail on a filename nobody thought of.

`lost` and `went-quiet` are separate arms and neither is folded into the other.
The behaviours before a refusal and before a fade are not the same behaviours.

### 2. The backfill — `src/main/deal-backfill.ts` + `OutcomeBackfillDialog.tsx`

Five answers: **Won · Lost · Went quiet · Don't remember · Not a deal.**

The last two are real answers, distinguished from each other and from an
unanswered row. That distinction is the only free diagnostic the backfill
produces: **above 50% "don't remember" among answered rows, the gate stays shut
and says the sample cannot be trusted** — even if the counts are met. A gate
that opens on biased-but-sufficient data is worse than one that never opens,
because the output looks earned.

An outcome answer creates a deal *and links that contact's coached calls to it*.
Without the link `hasMetricCall` stays false, the deal is unusable, and nineteen
rows of your time produce zero comparable samples. `linkedCallIds` records
exactly what was touched, so undo puts back that and nothing else.

### 3. The counter — `OutcomeInsightCard.tsx`, on the Pipeline board

States the requirement in full, once, then the current position. It does **not**
count down: a countdown implies the number is the point and that arriving at it
is imminent and automatic. It is neither.

### 4. The reason prompt — `OutcomeReasonPrompt.tsx`

A banner, not a dialog: a modal would block, and dismissing it would make "no
thanks" and "oops" the same gesture. Enter saves, Escape or ✕ skips, empty is a
skip. **Asked on won deals too** — asking only on losses builds a detailed
record of what goes wrong and nothing about what goes right, which is the same
one-armed sample the gate exists to refuse.

Three consecutive skips and it stops asking, and *says* it has stopped.
Answering resets the streak, so someone who answers most and skips the odd one
keeps being asked.

---

## Designed for the tenth row, not the first

15 rows in one sitting (the founder's framing was 19; the real list is 15)
means every unit of friction is multiplied by 15. Each rule below is a thing
the obvious implementation gets wrong:

1. **One click per row.** Buttons on the row. No dropdown (two clicks), no
   dialog (three plus a dismiss), no save step.
2. **The buttons never move and never disappear.** An answered row keeps all
   five, with the chosen one filled in — so *changing* an answer is also one
   click. The tempting version (collapse to a summary with a "Change" link)
   costs two extra clicks exactly when you have just realised you misclicked.
3. **Nothing reorders.** Answered rows do not sort to the bottom and are not
   removed. If they moved, the row under your cursor would change after every
   click, nineteen times.
4. **The row carries enough to answer it.** Name, company, coached-call count,
   date of the last one, its title. Opening a call to remember who someone was
   is a round trip; nineteen round trips is the abandonment.
5. **Clicking the same answer again is a no-op, not a toggle.** A double-click
   must not silently un-answer a row. Clearing is a separate ✕.
6. **Nothing blocks.** Writes are optimistic, buttons stay live, and a failure
   surfaces on its own row rather than as a modal.

---

## Verification

| Surface | How it was verified |
|---|---|
| Gate logic | `deal-outcomes.test.ts` — 14 tests, **7/7 red-check mutations** confirmed to fail |
| Gate reachability | `deal-union-lockstep.test.ts` — 2/2 planted bypasses caught and **named the offending file** |
| Backfill writes | `deal-backfill.test.ts` — 10 tests against a real temp profile |
| Three-way sync | `call-deal-link.test.ts` — absent preserves, null unlinks, malformed rejected, plus a control that the payload actually carries `dealId` |
| Rendered surfaces | Rendered in the running app, both themes, real data — see below |
| Call-to-deal link | `call-deal-link.test.ts` — 4/4 `setCallDeal` mutations red |

### The dev-profile override

`CALLRISE_USER_DATA_DIR` points a **dev** build at a copy of the profile.
Gated on `app.isPackaged`, so a packaged build never reads the variable —
pinned by `dev-profile-override.test.ts`.

It exists because driving the backfill in the live app would mean mutating real
deals and call records to test that mutating them works, and would race the
installed app, which shares that directory and was observed rewriting 178 call
files mid-session (`touchAllCallsForRepush`, all carrying one identical
`updatedAt`).

### Rendered in the running app — 2026-08-31

The signed-in app was unreachable (a copied-data-only sandbox has no session,
and seeding one meant copying an encryption key, which the permission layer
correctly refused). So the components were rendered **in the real running app**
a different way: imported through the Vite dev module server the app already
serves, mounted into the live page, with the real stylesheet, the real theme
tokens, the real preload bridge, and — for the backfill — **real rows** from
`dealBackfill.state()`, which is main-process and needs no auth.

`scripts/verification/render-surfaces.mjs`. What it confirmed:

- The counter, the reason prompt (won + lost), and the retired notice render,
  in **both themes**, with the founder's real numbers.
- The backfill renders **15 rows** — not the 19 measured earlier: that figure
  was "contacts with at least one coached call", and the backfill excludes
  contacts who already have a deal.
- Every row carries **all five answer buttons and a clear control**, read off
  the DOM rather than off the source — the tenth-row rule verified as a fact
  about the rendered page.

**What it is not:** the components are mounted directly rather than reached by
navigating a signed-in app. It says nothing about whether `DealsView` places
them correctly, or about clicking an answer end to end. That half is covered by
`deal-backfill.test.ts` against a real temp profile.

### THE DEFECT ONLY RENDERING FOUND

The counter said **"You have 0 won and 0 lost"** to someone whose Pipeline board
plainly showed **four Won deals**.

Both numbers were right. `usable` counts only deals with a linked call carrying
coaching metrics, and none of the four had one. But the screen gave no way to
tell *"you have no deals"* from *"your deals have no measurable calls"* — and
those need opposite actions. Every test was green; the gate was correct; the
copy was accurate about what it measured. It was still, on screen, wrong.

Fixed by adding `closed` to the `Insight` type (a count of what is recorded,
like `counts` — not analysis output, and pinned both by the key-enumeration
test and by a new test that the gate never opens on it). The card now reads:

> Countable right now: **0 won** and **0 lost**. The lost column is the one
> holding it back.
>
> You do have **4 won and 0 lost** on the board — but 4 of them have no linked
> call carrying coaching metrics, so they cannot be compared. Open a deal and
> link its calls under *Calls on this deal*, or link from the call itself.

### THREE VERIFICATION DEFECTS IN THE HARNESS ITSELF

Recorded because each would have produced a confident false pass:

1. **A body-text fallback that turned a blank render into a pass.** `Modal`
   portals to `document.body`, so `host.innerText` read 0 chars for a dialog
   that had rendered perfectly. Falling back to the whole body fixed that — and
   made a genuinely blank host pass too, because the login screen underneath is
   ~90 chars and cleared the 60-char threshold. A length check cannot tell "my
   component" from "whatever was already on screen". Now compares against a
   **baseline captured before the render**.
2. **A theme check that asserted on a class and not on the pixels.** Three
   errors stacked: there is no `dark` class (`useTheme` does
   `classList.toggle('light', ...)`, so dark is the *absence* of one); the
   substring test for `'light'` matched **`first-light`**, the design-preview
   class; and the assertion then passed on the junk `dark` class it had just
   added itself. Result: two byte-identical dark screenshots, reported as a
   light/dark pass. Now asserts that
   `getComputedStyle(document.body).backgroundColor` changes —
   `rgb(13,12,10)` to `rgb(255,254,252)`.
3. **Cleanup that did not clean up.** Removing the host `div` does not remove a
   portal, so every run left its modal on `document.body`: the row count went
   15 to 45 across three runs while every structural assertion kept passing on
   the pile. Now unmounts the React root and **verifies afterwards** that no
   stray answer buttons remain.

An opaque host at `z-index: 99999` also sat on top of the very dialog it was
meant to display — two byte-identical 7128-byte screenshots of a flat sheet,
while `innerText` read the modal correctly. Comparing screenshot **hashes** is
what caught it; the text assertion never would have.

---

## Two findings worth keeping

**A test that asserts its own name and proves nothing.** The per-arm rule's
first test used 12 won / 0 lost — which is insufficient whether the gate is
per-arm *or* a 16-deal total. It passed under a mutation that replaced the
per-arm gate with a sum. Only a red check found it; the fix uses 20-and-2,
where the total is well over the bar and only a per-arm gate refuses.

**A fixture that failed silently.** `saveCall` has no `contactId` field — the
link is a separate write — so passing one was ignored, every seeded call came
back with no contact, and the candidate list was empty. Four tests failed at
once, and the *first* of them was the control that says "the seed produced no
backfill rows". Without that control, three assertions about linking would have
passed vacuously against zero rows. Both fixture writes now check themselves.
