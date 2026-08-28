# M29 decision memo — B2 entitlements architecture

**Status:** DECISION MEMO + a built, inert scaffold. The *consumption* side
(model, token verification, cache, the one gate) is built behind a local
enforcement constant that defaults to **off**, so it changes nothing for any
user today. The *production* side (the table, the Stripe functions) is
written-but-not-deployed and waits on the new Supabase project and the
founder's Stripe decisions (B4). This memo records what was built, why it is
safe to build now, and the decisions still owned by the founder.
**Date:** 2026-08-24. **Author:** Claude (M29 session), for the founder.

**Founder-confirmed (2026-08-24), two architectural calls at standing-rule
weight — not to be revisited casually in a later session:**
1. **Enforcement-never-remote-flaggable is closed structurally, not by
   intention.** *"Some switches are too dangerous to be switches at all. A
   remotely toggled paid-feature gate is a free-money exploit waiting for
   anyone who can spoof or compromise flag delivery."* Full principle, with
   the consent-gate/telemetry-scrubber precedents this generalizes:
   `structurally-unflaggable-switches` in the assistant's memory.
2. **Verify-never-mint (client holds only the Ed25519 public key) is the
   right cryptographic shape** — *"even a fully reverse-engineered app can't
   manufacture its own entitlement. That's the honest version of 'we're not
   building DRM' from the original brief, done properly rather than
   hand-waved."*
3. **B4 and pricing Part D stay exactly where they are — do not build ahead
   of them.** *"I'm not close to Stripe yet, and I don't want B4 or any real
   gating built ahead of that... don't build ahead of a decision that isn't
   made."* Nothing past this memo's built scaffold should be started without
   a fresh founder go-ahead, even if it looks like a small, obvious next step.

---

## Why this could be built now, while the cutover and the clean-machine walk
## wait on the founder

The founder asked, explicitly: is there B2 prep that can be *designed and even
built behind a flag* without the new Supabase project or a clean VM? The
honest answer was **yes, the consumption side**, because of a clean seam:

- **Consumption** (does the app let a user use feature X?) is pure client
  code. It reads a signed claim it already has, or a safe default. It needs no
  server at all to run — that is the whole point of a *cached, signed*
  entitlement: the app keeps working on a plane.
- **Production** (how does that signed claim get written and delivered?) is
  the part that needs the new project, an edge function, and Stripe. None of
  it is built here — only the SQL and a written (undeployed) function shape.

Building the consumption side now is not speculative work: it is the single
load-bearing mechanism every monetization decision hangs off, it is the part
hardest to retrofit safely (the verify-not-mint property below), and — kept
inert by default — it cannot change what any user experiences until a future
release deliberately turns it on.

---

## The shape (what was built)

Five small pieces under `src/main/entitlements/`, plus tests.

### 1. The model — `types.ts`

```
Entitlement {
  plan: 'beta' | 'free' | 'pro' | string   // open-ended on purpose
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none'
  currentPeriodEnd: number | null           // epoch ms; null = perpetual (Option 3)
  seats: number                             // 1 today; multi-seat not precluded
  org: string | null                        // null today; org slot reserved
  managedAi: boolean                        // always false today; nothing reads it
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
}
```

Every one of Part G's "must not preclude" items is a field that exists today
and is simply constant: `seats:1`, `org:null`, `currentPeriodEnd:null`
representable, `managedAi:false`. Nothing has to change shape to add teams, a
one-time licence, or managed AI later — only the writer (the webhook) starts
setting them.

### 2. Verify, never mint — `token.ts`

The entitlement travels as a **signed token**: a JSON claim plus an **Ed25519**
signature. The client ships only the **public** key and can therefore *verify*
a token but can never *forge* one. The private key lives server-side (in the
webhook function's environment) and signs the claim after Stripe confirms
payment. This is the §5 requirement made concrete, and it is the property that
is miserable to retrofit — so it is built and tested now, with a test keypair.
The real public key is a placeholder constant the founder fills at billing
time (the key ceremony, below).

Verification rejects: a bad signature, a tampered claim, a token whose
embedded `userId` is not the signed-in user (so one user's token can't be
replayed on another's install), and — separately from signature validity — an
expired `currentPeriodEnd` past the offline grace window.

### 3. Cache + offline grace — `store.ts`

The last successfully-verified token is cached device-local, encrypted with the
same `safeStorage` primitive `auth.ts` already uses. On launch the app reads
the cache; if the server is unreachable, the cached entitlement stands until
**grace** expires. **Proposed grace: 14 days** past `currentPeriodEnd`
(decision below). Grace protects a paying user whose network or our server is
down; it is bounded so a canceled user can't stay Pro forever offline.

### 4. The one gate — `index.ts`

```
isEntitled(feature): boolean
```

This is the **only** entitlement check in the app — the `cancellable:true`
lesson from M26 applied to money: one helper, so a second, subtly-different
copy can never drift in (a structural test asserts it, see below). Everything
else — a menu item, a job executor, a settings card — asks `isEntitled`, never
reads the token or the plan directly.

### 5. The enforcement constant — LOCAL, never remote

`ENTITLEMENTS_ENFORCED` is a **compile-time constant in the entitlements
module**, currently `false`. While false, `isEntitled` returns `true` for
everything — the beta posture: every user has every feature, exactly as today.
When billing ships, a release flips it to `true` and `isEntitled` starts
reading the verified entitlement.

**It is deliberately not a remote flag, and this is load-bearing.** The
remote-flags memo's hard rule is "a flag can never grant or revoke a paid
feature." If enforcement were remotely toggleable, flipping it off would hand
Pro to everyone — a config compromise would be a free-money exploit. So the
entitlements module **does not import the flags module at all** (a structural
test enforces this — **note:** earlier drafts of this memo cited
`flags-cannot-reach-privacy.test.ts` here as existing precedent. **That file
does not exist**; it is described in `M29-remote-flags-memo.md`, a decision
memo whose own header says nothing in it is built. Taxonomy species 26. The
entitlements test stands on its own and its real scope is stated honestly in
`M29-sweep-findings.md` E1), and the
beta→enforced transition is a shipped build, not a switch.

---

## What was NOT built (waits on the founder)

- **The `entitlements` table.** SQL is written into the new-project
  provisioning checklist (`supabase/2026-08-entitlements.sql`, drafted below):
  read-but-never-write RLS (`select using (user_id = auth.uid())`), written
  only by the service-role webhook — exactly `alert_deliveries`' posture.
  Applied day one on the new project, per the species-23 cure (never
  incremental under time pressure).
- **The Stripe checkout + webhook edge functions.** The checkout function must
  read the caller's JWT (`createClient(url, anon, { headers: { Authorization }})`
  + `auth.getUser()`) so `client_reference_id = auth.uid` — none of the current
  functions read the JWT, so this is new code. The webhook verifies Stripe's
  HMAC over the raw body, upserts the `entitlements` row, and signs the token
  with the Ed25519 private key. **Not written as deployable code here** — it is
  coupled to the Stripe product/price ids, which are B4 decisions.
- **Any real Stripe integration.** Needs a Stripe account, product, and price —
  all B4, all the founder's.
- **Gating any actual feature.** `isEntitled` exists and is tested, but no menu
  item or executor calls it yet, because *which features are paid* is the
  pricing memo's open Part D decision. Wiring gates before that decision would
  be building a harness with nothing to put in it. The gate is proven by test;
  the wiring is a one-line-per-feature change once the founder picks the tier
  boundary.

---

## Decisions the founder owns

1. **Offline grace length.** Proposed 14 days past `currentPeriodEnd`. Longer
   is friendlier to paying users with flaky networks; shorter limits how long
   a canceled user coasts offline. (Stripe's own dunning is ~2–3 weeks, so 14
   days roughly matches "we'd still be trying to charge you.")
2. **The key ceremony.** At billing time: generate an Ed25519 keypair
   (`node -e "…generateKeyPairSync('ed25519')…"`), put the **private** key in
   the webhook function's secrets, ship the **public** key as the constant in
   `token.ts`. This key is **different from** the remote-flags signing key and
   the telemetry path — three separate trust domains, by construction.
3. **What's paid** (pricing memo Part D) — unchanged from that memo; needed
   before any gate is wired, not before the scaffold exists.
4. **Trial mechanics** — the `status:'trialing'` + `currentPeriodEnd` fields
   already represent a 14-day no-card trial (the pricing memo's lean); the
   founder confirms the trial shape when B4 is decided.

---

## Draft provisioning SQL (for the new project's day-one checklist)

```sql
-- entitlements: the client reads its own row, never writes; only the
-- service-role Stripe webhook writes. Mirrors alert_deliveries' RLS posture.
create table if not exists public.entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  status text not null default 'none',
  current_period_end timestamptz,          -- null = perpetual
  seats int not null default 1,
  org text,
  managed_ai boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  updated_at timestamptz not null default now()
);
alter table public.entitlements enable row level security;
-- read your own row only:
create policy entitlements_read_own on public.entitlements
  for select using (user_id = auth.uid());
-- no insert/update/delete policy for anon or authenticated: only the
-- service-role key (the webhook) can write, and it bypasses RLS.
```

The signed-token path means the app does not even need to read this table at
runtime in the common case (it verifies the cached token); the table is the
source of truth the webhook writes and the checkout/portal flows read. The
direct read is the fallback when a user has no cached token yet (first launch
after purchase on a new device).

---

## Verification of what was built

Same red-then-green discipline as the rest of M29. Claim-audit rows are in
`docs/M29-A1-plan.md`; in short:

- A token signed with a test private key **verifies** with the matching public
  key; a one-byte tamper of the claim, a wrong-user token, and an expired
  token past grace each **fail** — proven by breaking each and watching the
  specific assertion go red.
- With `ENTITLEMENTS_ENFORCED = false`, `isEntitled` returns true for every
  feature and never touches the store — the beta posture, proven by a test
  that would fail if enforcement leaked on.
- The structural test greps the entitlements module's import graph and fails
  if it ever imports the flags module — the remote-flags memo's guarantee, now
  enforced from the entitlements side too.
- The full suite stays green; nothing user-facing changed.

Back to `docs/M29-audit.md` §5 · the pricing memo Part G · the remote-flags
memo's "explicitly NOT flaggable" list.
