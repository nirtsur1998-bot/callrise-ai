# M29 decision memo — Remote flags (kill-switch)

**Status:** DECISION MEMO. Nothing here is built. The founder decides whether
to build it, and with which of the options below.
**Date:** 2026-08-23. **Author:** Claude (M29 session), for the founder.

---

## The question

When a shipped version has a broken AI purpose or feature, can we switch that
one thing off for everyone **without shipping a new version** — and can we do
it in a way that can never be turned against the user's privacy?

## The short answer

Yes, cheaply, with one hard rule: **flags can only turn things OFF, never ON,
and the privacy/consent code has no way to read them at all.** That rule is
enforced by the shape of the code, not by a policy. Details below.

## Why this is worth having (and why it's not urgent)

- The three real incidents M29 is designed around (BUG-080 silent retrieval,
  Sales Brain dead on clean Windows, the 1.3.0 Tier 1 gap) were all shipped
  bugs that a kill-switch could have *contained* within minutes of being
  noticed, instead of within the hours it takes to fix, build, publish and
  wait for users to click "Check for updates" (auto-update is off by default —
  see the rollout runbook §4).
- But: a kill-switch only helps once we can **see** the problem. Without the
  A1/A2 telemetry, we would not know to flip it. So A1/A2 come first; flags
  are the second half of "eyes and hands."
- Today's install base is tiny. The value of this grows with the user count.
  Building it now is reasonable because it is small (≈300 lines + a key
  ceremony); deferring it is also reasonable. **Recommendation at the end.**

---

## What would be flaggable (the allowlist)

A flag is a *named switch* from a **closed list** that lives in the code. The
remote config can only reference names from that list; unknown names are
ignored. Proposed initial list:

| Flag id | What turning it ON does | Failure mode if wrongly flipped |
|---|---|---|
| `kill.purpose.<name>` (one per AI purpose, e.g. `kill.purpose.memory-extract`) | That purpose's job returns "temporarily unavailable by CallRise" instead of calling any model. Live purposes (`coaching-cue`, `deal-tier1`) show nothing rather than an error mid-call. | Feature is off until the flag is lifted. Never worse than "feature broken", which is the situation that prompted the flip. |
| `kill.feature.<name>` from a fixed list: `rise`, `sales-brain-learning`, `sales-brain-retrieval`, `tier1-denoise`, `call-detection`, `backup`, `calendar-sync`, `contact-intelligence` | The feature's entry point is hidden or shows an "unavailable" card with honest copy. | Same. |
| `notice.min-version` + `notice.text` | Shows a dismissible banner: "Version X has a known problem — please update." No enforcement, no lockout. | Annoying banner. |

**Explicitly NOT flaggable, by construction (no flag id exists, and the
modules below never import the flags module):**

- Consent gate, consent retention, buyer-capture rules (`consent-gate.ts`,
  everything under `features/consent/`).
- Telemetry opt-in state, what telemetry contains, the scrubber.
- Data retention / deletion / "wipe this device".
- Auth, sign-in, device ownership.
- Entitlements (what's paid). Those come from a **different** signed token,
  with a **different** key, over a **different** path (B2). A flag can never
  grant or revoke a paid feature.
- Which model/provider is used, or any key routing. (A compromised config
  must not be able to steer traffic.)
- Anything that sends data anywhere.

The guarantee is structural: the flags module exports exactly one read
function, `isKilled(id): boolean`, defaulting to `false`. There is no
`isEnabled`, no value payloads, no strings that get rendered except the
`notice.text` banner (which is rendered as plain text, never HTML). A test
(proposed name `flags-cannot-reach-privacy.test.ts` — **NOT BUILT; nothing in
this memo is built, and this file has been miscited downstream as though it
existed, see taxonomy species 26**) would grep the import graph and fail the
suite if `consent-gate.ts`, the telemetry module, `auth.ts`, or the
entitlements helper ever imports `flags`.

---

## Failure mode: the config fetch fails

**Rule from the brief: must fail to current behavior, never to disabled.**

| Situation | Behaviour |
|---|---|
| Network down / fetch errors / 404 | Use the last **verified** config from disk if it is younger than its own `expiresAt` (proposed 7 days). Otherwise: **nothing is killed.** |
| Signature invalid | Ignore the file entirely. Keep the last verified one (same expiry rule). Record a health counter `flags.bad_signature` (A2) — this is either tampering or a key mix-up, both of which we want to know about. |
| Config is valid but older than the one we already have (`issuedAt` goes backwards) | Ignore it. Prevents replaying an old "kill everything" config. |
| Config names an unknown flag id | That id is ignored; the rest applies. |
| Device clock rolled back | `issuedAt` monotonic check above is against the *last seen* `issuedAt`, not the device clock. `expiresAt` is compared with device time — a rolled-back clock can at most keep a kill-switch alive longer, never enable anything. |
| App is offline forever | After 7 days every kill lifts and the app behaves exactly like a build with no flags at all. |

So the worst case in every row is "a feature we killed comes back," never
"a feature we didn't kill disappears," and never anything privacy-related.

---

## Why signed, and how

**Threat:** anyone who can change the file the app downloads can switch off
features for every user. If the file were on a server someone else controls,
or if our GitHub account were compromised, an unsigned config would let them
do that. Signing means the app trusts **a key the founder holds**, not a URL.

**Mechanism (no new dependencies):** Ed25519 via Node's built-in `crypto`.
A keypair is generated once. The **public** key is a constant in the app. The
**private** key lives only where the founder decides (see decision 2). The
config is a small JSON document plus a detached signature:

```json
{
  "issuedAt": "2026-08-23T10:00:00Z",
  "expiresAt": "2026-08-30T10:00:00Z",
  "kills": ["kill.purpose.memory-extract"],
  "notice": null
}
```

The app verifies the signature over the exact bytes, then parses. A config
that fails verification is never parsed at all.

**Hosting (no new vendors — pick one):**

| Option | How it works | Cost | Latency to take effect | Notes |
|---|---|---|---|---|
| **A. GitHub raw file** on a dedicated `flags` branch of the app repo | App fetches `https://raw.githubusercontent.com/nirtsur1998-bot/callrise-ai/flags/flags.json`. The founder commits a new signed file. | Free | Up to ~5 min (raw CDN cache) | Same host the updater already trusts. Public — anyone can read which features are killed (fine; it's not secret). |
| B. Supabase table `remote_flags` with anon `select` | App reads one row via the existing client. Founder updates the row in the dashboard. | Free tier | Immediate | Couples "can the app start features" to Supabase being up — but failure = nothing killed, so an outage is harmless. Puts a feature-control read on every launch through the same project that holds user backups; no privacy issue, but more surface. |

**Recommendation: A.** It's the simplest, it's free, it cannot touch user
data, and a compromised GitHub account still can't forge a signature.

**Fetch cadence:** on launch (after the 30 s startup delay the updater already
uses) and every 6 h, same as the updater's rhythm. Not mid-call — a flag that
arrives during a live call applies at the next call boundary, per the
"degrade at the next natural boundary" rule in the brief.

**What the fetch reveals about the user:** one GET of a public file, no
identifier, no cookie. GitHub sees an IP address, same as the update check
already does (which additionally sends the `.updaterId`; the flags fetch
would send nothing).

---

## Decisions for the founder

1. **Build it in M29, or defer to M30?** — Small (~2 days incl. tests and the
   red-check that a forged/expired/replayed config is ignored). Value scales
   with user count. *My recommendation: build it in M29 after A1/A2, because
   the kill list and the health signals are designed together — every
   `kill.purpose.*` maps to an A2 "purpose failure rate" signal, and that
   pairing is what makes the flip decision fast.*
2. **Where does the private key live?** — (a) Only on the founder's machine,
   signed by a local script (`npm run flags:sign`), committed by hand.
   Safest; requires the founder's machine to flip a switch. (b) A GitHub
   Actions secret with a manual "Publish flags" workflow. Flippable from a
   phone via the GitHub app; a repo-admin compromise can then also forge
   flags. *Recommendation: (a) now; the bar for (b) is "more than one person
   needs to flip switches."*
3. **Initial kill list.** — The table above, or a subset. *Recommendation: all
   AI purposes + `sales-brain-retrieval` + `tier1-denoise` + `rise`; those are
   where the three incidents lived.*
4. **Cache lifetime** 7 days (proposed) — longer means a kill persists longer
   offline; shorter means a kill lifts sooner if we forget to re-sign.
   *Recommendation: 7 days, and the sign script refuses to sign anything
   longer than 30.*

## Out of scope, on purpose

- Percentage / cohort flags ("turn X on for 10%"). That's what staged rollout
  is for, and it's already verified to work with zero code.
- A/B tests. Conflicts with the brand and the brief.
- Anything that sends the app a *value* (a prompt, a URL, a model name).
  Values are where a config becomes an attack surface.
