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

Today: **4 won, 0 lost.** The backfill covers ~19 contacts. Even a perfect
backfill will not reach the bar on its own — that was measured before it was
built, and the counter says so on screen rather than implying an arrival date.

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

19 rows in one sitting means every unit of friction is multiplied by 19. Each
rule below is a thing the obvious implementation gets wrong:

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
| Rendered surfaces | **See "Open" below** |

### The dev-profile override

`CALLRISE_USER_DATA_DIR` points a **dev** build at a copy of the profile.
Gated on `app.isPackaged`, so a packaged build never reads the variable —
pinned by `dev-profile-override.test.ts`.

It exists because driving the backfill in the live app would mean mutating real
deals and call records to test that mutating them works, and would race the
installed app, which shares that directory and was observed rewriting 178 call
files mid-session (`touchAllCallsForRepush`, all carrying one identical
`updatedAt`).

### Open

The dev app against a fresh sandbox profile stops at the **login screen** —
there is no session in a copied-data-only profile, and seeding one would mean
copying a live auth token into a temp directory. So the three rendered surfaces
have **not** been driven in a running app yet. That is stated here rather than
implied away.

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
