# BUG-096 — how should an unscoped Rise chat decide it doesn't know?

**Status:** DECISION MEMO. Nothing built. The founder asked for the shape
before any code. **Date:** 2026-08-24.

**Scope note:** the *instrument* half of BUG-096 is done — the harness labels
now name the default shape as the default (`callrise-m28` @ `a21e9d7`). This
memo is only the product half.

---

## The problem in one paragraph

Rise passes `contactId: scope?.contactId ?? null`. In the default "New chat"
that is `null`, so `rag.ts` builds its scope list as `['rep','business']` and
**every `client:*` memory is unreachable by construction.** Measured: 8/14
(57%) versus 13/14 (93%) in a bound conversation.

**The recall number is not the problem.** Empty answers stay **0/13** — the
client questions do not come back empty, they come back with *generic
business-scope* memories. Asked *"who makes the buying decisions at Acme?"* in
an unscoped chat, retrieval returns `b-icp`, `b-objection-impl`, `b-product`,
and **Rise answers confidently from the wrong context.** A confident wrong
answer about a named client is worse than "I don't know" — and it is worse than
silence, because the rep has no signal to distrust it.

---

## What has to be true of any fix

1. **Never answer a client question from business-scope memories as if they
   were about that client.** This is the actual defect. Everything else is
   optimisation.
2. **Never leak across clients.** The harness asserts `violations <= 0` as a
   hard invariant at every threshold. Any option that widens scope must keep
   that at zero, and must be measured, not assumed.
3. **Don't make the common case worse.** Most questions in an unscoped chat are
   *not* client-specific ("how do I handle a pricing objection?"), and those
   are answered correctly today. A fix that adds friction to all questions to
   repair some is a bad trade.
4. **Measurable by the existing harness**, so the claim is a number and not a
   feeling.

---

## Option A — Refuse: don't answer client-specific questions unbound

Detect that the question names a client, and if no client is bound, decline and
ask the rep to bind one.

- **Good:** strictly honest; impossible to answer from the wrong context; small
  and easy to reason about.
- **Bad:** it is a dead end in the UI, and the rep is being asked to do
  bookkeeping the app could do. It also converts a *wrong answer* into a
  *refusal to answer* even in cases where retrieval would have been right —
  e.g. the memory lives in `rep` or `business` scope and genuinely does answer
  the question.
- **Risk:** detection is the whole game. Under-detect and nothing changes;
  over-detect and Rise starts refusing general questions that happen to mention
  a company name.

## Option B — Auto-scope: detect the client and bind the conversation

Resolve the named client from the question (against the contacts store, which
already has `findByName`) and search that client's scope.

- **Good:** the highest-recall answer, and it is what the rep meant. It would
  move the unscoped number toward the bound number — the only option that
  actually *raises* 57%.
- **Bad:** it makes retrieval scope depend on a fuzzy name match, and a *wrong*
  match is a **cross-client leak** — the invariant we most care about. "Acme"
  vs "Acme Corp" vs two contacts at the same company is exactly where this goes
  wrong.
- **Risk:** this is the only option that can make things worse than today. It
  needs the match to be exact-and-unique, with an explicit "which Acme?" when
  it is not — and the harness's `violations` assertion becomes the gate that
  decides whether it ships.

## Option C — Answer generally, but say so explicitly

Answer from `rep`/`business` scope as today, but when the question named a
client that has no bound scope, prefix the answer with the limitation: *"I
don't have memories about Acme specifically — here's what I know generally."*

- **Good:** closes the actual defect (the confident wrong answer) without
  touching retrieval scope at all, so the cross-client invariant is untouched
  by construction. Smallest blast radius of the three. Keeps the generally-
  useful answer instead of throwing it away.
- **Bad:** does not raise recall — 57% stays 57%. It makes the failure honest
  rather than fixing it.
- **Risk:** depends on the same client-detection as A. If detection misses, the
  disclaimer is absent and the behaviour is exactly today's.

---

## What I would do, and why

**C first, then B behind the harness.** The reasoning:

- The defect the founder named is *the confident wrong answer*, and **C fixes
  exactly that** while leaving the invariant we care most about untouched. It
  is also the only option that cannot make anything worse.
- **B is the only real cure** for 57%, but it is the one option whose failure
  mode is a cross-client leak — the thing the founder called a trust violation
  in a different context this same day. It should not ship on reasoning; it
  should ship on a harness run showing recall up **and** `violations` still 0.
- **A is C without the useful half.** Refusing is more honest than answering
  wrongly, but C is honest *and* still answers the general question. I would
  only pick A if client-detection turned out reliable enough to refuse on but
  not reliable enough to scope on — which seems unlikely, since both need the
  same signal.

Sequencing C → B also means the disclaimer already exists when B lands, so an
ambiguous match has somewhere to fall back to: *"I found two contacts named
Acme — here's what I know generally, or pick one."*

**All three depend on the same unbuilt piece: deciding a question names a
client.** That is the real work, and it is shared. I would build it once, with
its own test, and let the founder's chosen option consume it.

---

## What I need from you

1. **Which option** (or a different one).
2. For B, if chosen: **is an auto-bind allowed to be silent**, or must it always
   be visible ("Talking about Acme") with a way to undo? My assumption would be
   visible-and-undoable, since silent scope changes are how cross-client
   accidents become invisible.
3. Whether raising 57% is **this milestone's** work at all, or whether C is the
   right stopping point until Rise has real usage to learn from.
