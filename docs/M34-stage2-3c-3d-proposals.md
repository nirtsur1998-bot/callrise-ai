# M34 Stage 2 — HUD proposals 3c and 3d (propose, don't build)

Written 2026-09-04. **No code written.** These are scoped for the founder to
approve, redirect, or reject, per the propose-don't-build convention. Grounded
in what the live surface actually is today, surveyed rather than remembered.

The live screen renders eleven things during a call: `MustAskStrip`,
`Waveform`, `EngagementGauge`, `MonologueMeter`, `TranscriptView`,
`SuggestionRail`, `CueCard`, `AskCoach`, `DealIntelligencePanel`,
`OtherPartyControl`, `CueControls`. That is the surface both proposals touch.

---

# 3c — load reduction

**The problem, in the milestone's own words:** nine-plus instruments compete for
attention on the screen watched under the most stress. The question is not
"which are wrong" (Stage 3a answered that) but "which are worth their space
mid-call, and who decides."

**What already exists** (so 3c extends, not invents): `useCueSettings` persists
`enabled` + `sensitivity` (`low`/`medium/`high`), and Deal Intelligence has its
own `quiet`/`balanced`/`aggressive`. So the app already has the idea that a rep
tunes how much the screen talks — it is just spread across two controls and
neither hides an instrument, only quiets the cues.

## The distinction that should drive it: interrupting vs glanceable

- **Glanceable, passive** — you look when you choose: `TranscriptView`,
  `EngagementGauge`, `MonologueMeter`, `Waveform`, `MustAskStrip`. These cost
  screen space but never grab you.
- **Interrupting** — they appear and demand a read: `CueCard` (the nudge that
  pops), the `SuggestionRail` filling, `DealIntelligencePanel` surfacing a
  signal. These cost attention, which is the scarce thing mid-call.

Load reduction is mostly about the second group. Space is cheap; a pop-up during
a hard moment is not.

## Proposal 3c — a single "Focus" toggle on the live screen, plus one honest setting

**DECISION (yours): the shape of the control.** Two options, and I recommend A.

- **3c-A (recommended) — one toggle, live, on the screen.** A "Focus" control in
  the live header. On, it collapses to **transcript + MustAskStrip + the health
  indicator**, and silences the interrupting group (no CueCard pop, rail
  collapsed to a count you can expand, DI panel hidden). Off, everything as
  today. One switch, reversible mid-call, no settings trip. It maps to state the
  components already receive, so it hides rather than unmounts — cheap and
  instant.
- **3c-B — a density setting in Settings.** More granular (per-instrument
  show/hide) but it makes the rep configure their screen in advance, away from a
  real call, which is exactly the guessing the scope warns against.

**Why A.** The scope is explicit that this is *"taste + how you actually use the
screen; needs your read of a real call, not a guess."* A live toggle lets you
find the answer ON a call instead of predicting it in Settings. And it is
honest about what it does: it hides instruments, it does not pretend they are
gone.

**The one setting worth adding regardless:** a visible **cue-frequency cap** —
"at most one cue every N seconds" — surfaced in `CueControls`, not buried. Today
the rep cannot see or set the pace. That is a genuine load lever and it is not
taste.

> ⚠ **Cost estimate flagged as optimistic (audit, 2026-09-04).** The line above
> originally read "the nudge engine can already pace." Checked against source:
> what exists is a cooldown on the interrupt channel, not a per-cue frequency
> cap, and no setting feeds it. So the cap is not "expose a knob that exists" —
> it is a small new mechanism in the nudge path plus the setting. Still small;
> not free. Budget it as such before deciding.

**Explicitly NOT proposed:** removing any instrument for everyone, or a redesign
of the layout. 3c is "let the rep turn the volume down mid-call," not "rebuild
the screen."

**Cost:** small. A toggle + conditional render on existing props, one new
persisted setting. Days, not a milestone.

---

# 3d — deal facts on the HUD

**The idea:** on a call linked to a deal, show that deal's own **records** —
stage, and the last outcome reason for this contact — so the rep has context
without leaving the call. Records, not analysis.

**The hard constraint, and it is load-bearing:** the outcome-tracking gate is
closed and will stay closed for months. **Nothing on the HUD may show an
outcome-DERIVED number while the gate says insufficient** — the import-graph
test enforces this structurally and the HUD gets no exemption. So 3d must be
records the deal already holds, never "what wins calls."

## What is safe to show (records, gate-independent)

From the `Deal` record, all present today, none derived from the closed gate:

- **`stageId`** — the deal's current stage (Working / Won / Lost / Went quiet).
  A fact the rep set.
- **`outcomeReason`** — "why the deal ended this way, in the user's own words"
  (M32 Stage 2). On a *past* deal with the same contact, this is the rep's own
  note, verbatim. Not analysis.
- **`stageHistory`** — the deal's own transitions, oldest first. A timeline the
  rep created.

## What is NOT safe (and 3d must refuse)

- Anything from `OutcomeCounts` / the insight gate — win rates, "calls like this
  close X%", any cross-deal aggregate. That is the closed gate, and the HUD
  cannot launder it.
- `riskAssessment` — it is AI-derived. That belongs to Deal Intelligence's own
  panel (M24), which has its own gating; 3d must not duplicate or pre-empt it.

## Proposal 3d — a one-line deal strip, records only

**DECISION (yours): whether to show it at all.** A single quiet line on a
deal-linked call: **`<contact> · <deal stage> · last time: "<their own outcome
reason>"`** — pulled straight from the linked deal record, no computation. It
answers "what do I already know about this deal" without the rep opening the CRM
mid-call.

**Why one line, not a panel.** 3a just found that panels on this surface accrue
into clutter (and worse, into the instruments that lie). A records strip earns
its place only if it stays a strip. A panel is 3c's problem, not 3d's solution.

**The gate guard, concretely:** the strip reads only `stageId`, `outcomeReason`
and `stageHistory` off the linked `Deal`. It imports nothing from the insight
module. **I would propose pinning that with an import-graph test** — the same
mechanism that already keeps outcome numbers off ungated surfaces — so the strip
cannot later grow a win-rate without a red test.

**Cost:** small, IF a deal is already linked to the call. The link exists
(`currentMeeting.dealId` is already on the live surface). If no deal is linked,
the strip is absent — no "link a deal" flow, that is out of scope.

---

## Sequencing and the honest end

Both are small and independent. My recommendation: **3c-A + the cue-frequency
cap first** (it addresses the clutter 3a exposed), **then 3d as one line** if you
want deal context on the call.

Either can be dropped with no loss to the other, and Stage 2 can end honestly
after 3c alone if 3d turns out to be context you do not miss mid-call. As with
Stage 1, the milestone can stop at any boundary.

**Nothing here is built.** DECISION points: 3c-A vs 3c-B; whether 3d ships at
all; and whether the cue-frequency cap is wanted independently of the Focus
toggle.
