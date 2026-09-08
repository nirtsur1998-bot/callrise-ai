# The nightly reflection pass, and the sentence I want to add

**2026-09-08. Nothing is committed. The words are yours to approve.**

Everything below I read in the code myself rather than taking from a review, per the practice now at
the top of the taxonomy.

---

## What actually happens

**Once a night, for every scope, the Sales Brain sends the facts it holds to your AI provider.**

`runNightlyConsolidation` walks every distinct scope — `rep`, `business`, and one for **each
client** — and calls `runReflection` on each. That function takes every **active** memory in the
scope and posts their statements to your configured provider as a numbered list, asking it to find
patterns across them.

| | |
|---|---|
| What is sent | the memory **statements**. The derived facts, one per line |
| What is NOT sent | the verbatim quotes, the evidence, the call ids, the transcripts |
| How often | nightly, per scope. A rep with 20 clients has 22 scopes |
| What comes back | new "reflection" memories, born as hypotheses with capped confidence, requiring at least two independent supporters |

**It is gated on one thing only: Sales Brain being switched on.** Not on sign-in, not on backup, not
on the transcripts toggle. `maybeRunNightlyConsolidation` checks `isSalesBrainEnabled()` and nothing
else.

**So it fires for a user who has never signed in.** That is the case that matters. Someone who never
turned on backup, and believes their Sales Brain is a local thing, has everything it has learned
about them sent to an AI provider every night.

**The only place it currently surfaces** is the Job Inspector, as the raw type string
`salesBrain:nightlyConsolidation`. That is a developer's view of a queue, not a disclosure. Nothing
a user would read tells them this happens.

---

## What I got wrong in my own summary to you

I told you reflection "sends every fact to the provider nightly", which is right, but I let you
infer it was of a piece with the transcript egress. It is not. **The quotes never leave in this
pass.** What leaves is the derived sentences: "Prefers to open with a question", "Budget indication
around 40k". That is still your business in a list, and it is still going somewhere you were never
told about. It is not raw buyer speech.

The distinction matters for the wording, so I am flagging it rather than letting a sentence rest on
the stronger version.

---

## The draft

For `SalesBrainSection.tsx`, the card where the feature is switched on, appended to the description
you already approved:

> **Once a night it also sends the facts it has learned to your AI provider, to look for patterns
> across them.**

That is one sentence, it needs no caveat to stay true, and it survives the cases that killed the
last four rounds:

- **signed out** — still true, because the pass does not care
- **backup off** — still true, same reason
- **transcripts off** — still true, and it is the one place a user could otherwise reasonably assume
  they had stopped this
- **a fresh profile versus an upgraded one** — no dependence on either
- **it names no settings page**, so there is nothing to drift

### Two alternatives, in case you want a different emphasis

If you want the frequency and the scope named:

> Once a night it sends the facts it has learned, including what it knows about each client, to your
> AI provider to look for patterns.

If you would rather the user could stop it than be told about it, that is a different change and a
bigger one: a switch of its own on the same card. I have not built it, because "tell them" and "let
them stop it" are separate decisions and you have only asked for the first.

---

## What I would put in front of you alongside it

The reflection pass is the clearest case of a pattern this milestone keeps finding: **a feature that
is defensible, deliberate and well built, doing something the user has no way to learn about.** The
fix is never the feature. It is that nothing in the product's own voice describes it.

There are now three of these open: this one, the always-on push carrying call summaries and client
names (BUG-212), and the AI provider destination having no control distinct from turning features
off (BUG-223). They are all the same shape and they are all copy plus a decision, not code.
