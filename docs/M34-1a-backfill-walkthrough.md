# The 13-row backfill — exact steps, one sitting

Written 2026-09-04 from the shipped UI, not from memory. ~13 rows, one click
each — call it five minutes if you know the outcomes, longer where you have to
remember who someone was.

## Getting there

1. **Pipeline** (main nav) → **CRM** tab → **Deals** tab.
2. On the Deals board, near the top, a card shows your outcome-tracking status.
   When rows are waiting it carries a button: **"Record past outcomes (13)."**
   Click it.

If the button is not there, the count is zero — nothing to do. It only appears
while unanswered rows exist.

## What you'll see

A dialog listing your coached contacts who don't already have a deal — **13
rows** (your 19 coached contacts minus the 6 already linked to a deal). Each row
shows the contact, their company, how many calls, and the last call's date and
title, so you can place them.

Every row has the **same five buttons**, in the same order, and they never move:

| button | use it when |
|---|---|
| **Won** | they bought |
| **Lost** | they said no |
| **Went quiet** | it faded out — no decision either way *(counted on its own, never as a loss)* |
| **Don't remember** | you genuinely can't recall — a real answer, better than a guess |
| **Not a deal** | **this is your support calls, colleagues, and test calls** — never a pursuit |

## Your two questions, answered

**"Not a deal" is a distinct button, not a skip and not the same as "Don't
remember."** Use it for every one of those 19 that was support, a colleague, or
a test. It records that the contact was seen and was never a real prospect, so
they're correctly excluded rather than sitting unanswered forever. You will not
have to skip anything or leave rows blank.

**"Don't remember" is for a contact who WAS a prospect but whose outcome you
can't recall.** It's a first-class answer that keeps the rest trustworthy — the
gate treats a pile of "don't remember" as low-confidence rather than pretending
you know. Different meaning from "Not a deal," and the app keeps them separate.

## How it behaves (verified against your real data, 2026-09-04)

- **One click saves it.** No confirmation dialog, no second step. The row shows
  its answer immediately.
- **Answers save as you go.** If you close the dialog at row 7 and come back
  tomorrow, rows 1–7 are still answered. Progress is written to disk per click,
  not at the end.
- **Undo is just clicking a different button** — or the same one again to clear
  it. The row returns to unanswered; nothing is deleted.
- **Rows never reorder.** An answered row stays exactly where it was. Row ten is
  always where row ten was.
- **If a save fails** (a locked file, say), the error appears **on that row**
  and the answer rolls back, so you never see a row that looks saved but isn't.

## What I could not test, and only you can

Whether row ten *feels* like row one — the fatigue, the rhythm, whether the
five buttons stay legible when you're moving fast. The mechanics are identical
across all 13 rows; the experience is yours to judge. That's the report I'm
waiting on.
