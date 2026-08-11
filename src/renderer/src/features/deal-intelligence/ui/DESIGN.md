# Deal Intelligence Panel — design notes

## What this is

`DealIntelligencePanel` (`DealIntelligencePanel.tsx`) is the flagship,
always-watching counterpart to Gong-style post-call analytics: a compact,
corner-sized HUD that surfaces rare, high-value risk/opportunity/tactical
nudges as evidence-first briefs, not notification toasts. Presentational
only — no data-fetching, no IPC, exactly the `DealIntelligencePanelProps`
contract in `types.ts`.

Files:

- `types.ts` — the fixed data contract (`Nudge`, `DealIntelligenceStatus`,
  `DealHealthScore` + its `HealthFactors`/`HealthTrajectory`,
  `DealIntelligencePanelProps`).
- `meta.ts` — per-`NudgeType` icon/color/label mapping + `formatSubtype` /
  `formatRelativeTime`, plus the Health Score tone/trajectory/factor
  metadata (`healthScoreTone`, `HEALTH_SCORE_TONE_META`,
  `HEALTH_TRAJECTORY_META`, `HEALTH_FACTOR_ORDER`, `HEALTH_FACTOR_LABEL`).
- `ConfidenceMeter.tsx` — 5-segment bar + exact percentage.
- `CollapseTransition.tsx` — generic CSS grid-rows collapse wrapper, used
  for card dismissal, evidence expand/collapse, the quiet-notice recede, and
  the Health Score card's factor breakdown.
- `PresenceHeader.tsx` — the persistent "is this thing alive" status pill
  and its breathing/flashing dot.
- `StatusNotice.tsx` — the idle / quiet / paused explanatory copy card.
- `NudgeCard.tsx` — one nudge: verdict, evidence receipt, confidence,
  timestamp, feedback.
- `HealthScoreCard.tsx` — Tier 2's compact score/trend/top-recommendation
  card, with the 5-factor breakdown behind an expand toggle.
- `DealIntelligencePanel.tsx` — orchestrates all of the above; the module's
  main export.

## Which concept this is based on

Three concepts were built and independently judged (`radar`, `analyst`,
`ambient`; all judges scored **Analyst highest**, 39–41/50). This panel uses
**Analyst as its base** — its always-visible evidence "receipt" block and
dual-encoded confidence meter (5-bar + exact %) are the most rigorous,
production-ready answer to the brief's hard requirement that
evidence-transparency not be optional, and its quiet, dense, editorial
register is the closest fit to this app's existing calm materials
(`glass-hud`, `glass-sheen`, CueCard's own enter transition).

It is **not** a straight copy of Analyst — three specific ideas were grafted
in from the other two concepts, per all three judges' independent
recommendations:

1. **A persistent, "alive" presence indicator (from Radar).**
   Analyst's original header was a static icon + text-only status pill, plus
   a separate always-visible "Quiet is normal" card underneath it whenever
   there was nothing to show — two rows of screen real estate spent through
   the quiet majority of every call, which is exactly the state the
   product's own framing ("rare nudges") calls typical. `PresenceHeader.tsx`
   replaces that combo with a single slim pill: a small dot that breathes
   (`.pulse-ring`, reused, not reinvented) while active, glows amber while
   paused, and flashes once (`.flash`, also reused) the instant a new nudge
   arrives. It never unmounts in any status — it's the one thing that makes
   "we watch continuously, unlike Gong's after-the-fact analytics" something
   felt on screen for the whole call, not just claimed in copy. Deliberately
   toned down from Radar's original: no continuous conic-sweep animation
   (all three judges independently flagged that as too much theatrical
   motion for something that has to sit on screen for an entire call).

2. **True silence isn't permanent, but it isn't instant either (from
   Ambient, adapted).** Carrying Ambient's `active + empty → render null`
   behavior forward as-is would contradict Analyst's own rationale for why
   the quiet-state copy exists (a live tool that goes fully silent with no
   explanation reads as broken) — and champions this synthesis is explicitly
   supposed to avoid. Instead, `useQuietGraceWindow` in
   `DealIntelligencePanel.tsx` shows the "quiet is normal" notice for one
   grace window (~9s) the first time a call goes quiet, then lets it recede
   to just the header dot for the rest of that quiet stretch — explains
   itself once, then gets out of the way, without ever going fully dark.
   The recede itself uses Ambient's CSS `grid-template-rows` collapse
   (`CollapseTransition.tsx`) rather than a flat unmount, which is also
   strictly better than Analyst's original mount-only enter transition: it
   gets a real, honest-feeling exit animation for free, and — because it's a
   plain CSS transition rather than a bespoke keyframe — it inherits
   `index.css`'s blanket `prefers-reduced-motion` override automatically,
   with no separate JS branch to get wrong.

3. **A differentiated icon set + truncate-older-evidence discipline (from
   Radar / Ambient).** `meta.ts` uses `ShieldAlert` / `Target` / `Compass`
   instead of reusing the existing `CueCard`'s `AlertTriangle` /
   `TrendingUp` — Deal Intelligence is meant to supersede that system, not
   read as a reskin of it. And in `NudgeCard.tsx`, only the **newest**
   nudge (index 0) keeps Analyst's structurally un-collapsible evidence
   block; older, receding nudges show a one-line quote preview with a
   click-to-expand toggle (Ambient's pattern) for the full receipt. This
   directly neutralizes Analyst's own admitted honest tradeoff — three
   always-expanded evidence blocks crowding a short window — without
   weakening evidence-transparency on the one nudge a rep is actually
   deciding on right now.

The same `CollapseTransition` primitive also drives per-card dismissal:
clicking the X starts a real exit animation, and the `onDismiss(id)` prop
only fires from the transition's own `onTransitionEnd`, never synchronously
from the click — so a card can never visually vanish out from under its own
motion, closing the one clear polish gap judges called out in Analyst's
original mount-only implementation.

## Deal Health Score (Tier 2)

Tier 1 (the nudges above) and Tier 2 are two independent AI passes on
different cadences — Tier 1 reacts within seconds to specific transcript
moments, Tier 2 runs every 2-3 minutes over the whole call so far and
produces a single 0-100 health score, a breakdown across 5 factors
(engagement, sentiment, objection status, momentum, agenda coverage), a
trajectory vs. the previous score, and one top strategic recommendation.
`HealthScoreCard.tsx` is this panel's presentation of that pass:

- **Compact by construction.** The brief for this panel was "one more thing
  in an already-careful small panel, not a dashboard," so only the score,
  its trajectory arrow, and the top recommendation are visible without
  interaction. The 5-factor breakdown — genuinely secondary, it's the "why"
  behind a number the rep already has — sits behind an expand toggle using
  `CollapseTransition`, the same primitive `NudgeCard` already uses for its
  own evidence disclosure, rather than a second collapse mechanism.
- **The top recommendation gets real visual weight**, not a footnote: it's
  rendered in a tinted, bordered block, reusing the accent "suggested
  action" idiom `RiskAssessmentCard` (`features/deals/`) already established
  elsewhere in the app for the same job — the one recommended move an AI
  pass surfaced. It is the second most important thing on this card, after
  the score itself, because it's the one strategic thing Tier 2 has to say
  this round.
- **Its own small card, not folded into `PresenceHeader`.** `PresenceHeader`
  was deliberately collapsed from a wider masthead down to a slim,
  always-present pill (see that file's own doc comment) specifically
  because it's the one element that has to be on screen for the _entire_
  call in every status. A Tier 2 score doesn't share that property — it
  doesn't exist until the first pass lands (~2-3 minutes in) and only
  updates on its own slow cadence after that — so re-widening the one
  permanent element to fit it would undo that specific, deliberate
  restraint for a feature that was never meant to be permanent the same way.
  It mounts as its own card directly under `PresenceHeader` instead.
- **Same tone convention as the rest of the app.** The score (and each
  factor bar) uses the same 65/positive · 50/warning · below/danger
  thresholds `ScoreGauge` already applies to the app's other 0-100 scores,
  so a "70" reads as equally good news here as it does on a coaching
  report — implemented as a local `healthScoreTone` helper in `meta.ts`
  rather than an import, matching this folder's existing practice of
  mirroring small stable rules across its own boundary instead of coupling
  to them.
- **`null` renders nothing extra**, never a placeholder or a zeroed score —
  "no Tier 2 pass has completed yet for this call" and "the deal is
  scoring at 0" are different facts, and showing the latter for the former
  would misrepresent it.
- Semantic tokens only (`text-positive`/`warning`/`danger`, `text-ink`/
  `muted`/`faint`, `bg-accent-soft`, etc.) and `prefers-reduced-motion` is
  respected the same way the rest of this folder gets it for free — the
  factor bars' width transition and the expand chevron's rotation are plain
  CSS transitions, which inherit `index.css`'s blanket reduced-motion
  override with no separate JS branch.

## Mounting

```tsx
<DealIntelligencePanel
  enabled={dealIntelligenceEnabled} // the beta toggle in settings
  status={dealIntelligenceStatus} // 'idle' | 'active' | 'paused' from useDealIntelligence()
  nudges={visibleNudges} // already gated/ranked by the Nudge Engine
  onDismiss={dismissNudge}
  onFeedback={rateNudge} // optional; omit to hide the thumbs affordance entirely
  healthScore={latestHealthScore} // DealHealthScore | null from the Tier 2 pass; null until the first one completes
/>
```

The root renders a plain `w-80` flex column with **no** `fixed`/`absolute`
positioning of its own — same convention `CueCard`/`SuggestionRail` already
use in `LiveView.tsx` (positioning belongs to the screen that owns the
floating column, not to the widget). `LiveView.tsx` currently reserves its
top-3/right-4/bottom-4 column for `SuggestionRail` + `CueCard`; since this
panel is meant to eventually supersede that pair rather than sit beside it,
the simplest integration is to swap it in for that same column once the
Nudge Engine is wired up. If both systems need to coexist during a
transition period, mount this panel in a second `pointer-events-none
absolute` wrapper anchored to the **opposite** corner (e.g. `top-3 left-4`)
so the two floating stacks can never overlap.
