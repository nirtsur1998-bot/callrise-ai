# The board overflow — options, as promised

**Deferred by the founder on 2026-08-31 ("don't design around the overflow yet —
bring me the options after the stage is finished"). The stage is finished.**

## The problem, measured

Adding the **Went quiet** column makes the Pipeline board 7 columns. Measured in
the running app: **~1888px of board in a ~646px pane — 1242px hidden** behind a
horizontal scroll with no affordance saying so. The columns most likely to be
off-screen are exactly the closed ones (they sit at the end), so the outcome
counter can say "you have 4 won" above a board where the Won column is
invisible — a small species-62 cousin: the state exists, the screen doesn't
show it, nothing says why.

Deals-per-column today: almost everything sits in the open columns; Won holds 4;
Lost and Went quiet hold 0. The closed columns are **records, not workspaces** —
nobody drags cards around inside Won.

## Options

### A. Leave it, add affordance only
Horizontal scroll is normal kanban (Trello, Linear). Add an edge fade + a subtle
"5 more columns →" hint, maybe drag-to-scroll.
- **Cost:** half a day. **Risk:** none.
- **Against:** the founder still pans 1200px to see an empty Lost column. The
  affordance fixes discoverability, not the distance.

### B. Collapse closed-kind columns to count rails *(recommended)*
Won / Lost / Went quiet render as narrow vertical rails — label + count + total
value — expanding to a full column on click (state remembered). Open columns
keep full width and all fit without scrolling at today's pane sizes.
- **Cost:** ~1 day incl. driving it in the app. **Risk:** low; no data change,
  purely presentational, reversible per-column.
- **For:** matches what the columns *are* — outcomes are glanced at, pipeline is
  worked. The counter card sits directly above and already carries the numbers.
- **Against:** one click to see the cards in a closed column. (Opening the deal
  from the list view is unaffected.)

### C. Column show/hide chips
A filter row like the list view's stage chips; hidden columns persisted.
- **Cost:** ~1 day. **Risk:** a hidden column is a species-62 machine — deals
  "vanish" and the board's "N total" disagrees with what's visible. Would need
  an explicit "3 columns hidden" marker to stay honest.

**Recommendation: B.** It encodes the open/closed distinction the whole
milestone has been building on, costs one click only where a click is cheap,
and can't hide data silently (a rail still shows its count).

Not proposing: narrower columns (cards become unreadable before the board
fits), or auto-collapse only Went quiet (special-casing one closed kind
re-creates the asymmetry `CLOSED_STAGE_KINDS` exists to prevent).

**Decision needed:** A, B, or C — or "leave it entirely" is also a legitimate
answer at 4 closed deals.
