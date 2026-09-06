# M37 Stage 3 — CRM sync: the wedge, and the decision that defines it

**2026-09-07. Research and a proposal. NOTHING is built, and nothing is written to any CRM.**
Five parallel readers surveyed HubSpot, Salesforce, the smaller CRMs, the competition and our own
codebase; three independent proposals answered the founder's decisive question; three judges scored
them through different lenses. Every factual claim below carries a source. Where the research could
not establish something, it says so.

---

## 1. The headline: HubSpot first is defensible, but three of the assumptions under it are wrong

The founder's framing was *"HubSpot's free tier is the obvious start — tell me if it's wrong."*
It is not wrong, but it is not obvious either, and the reasons matter more than the answer.

**Correction 1 — OAuth is a wall for a desktop app, so the credential is a pasted token.**
HubSpot's CRM APIs do not support PKCE, and `client_secret` is mandatory on the `refresh_token`
grant. A local desktop app has nowhere to keep a client secret. Any new OAuth app also lands on the
new app platform, capped at **25 installs** until it passes HubSpot marketplace review. The
five-minute path for a solo rep is a token they generate in their own account and paste into
CallRise — exactly like the Deepgram and AI keys the app already asks for.

**Correction 2 — that token path is mid-migration, with a deadline inside this month.**
Legacy private app creation is disabled **28 September 2026** for new accounts and **26 October
2026** for existing ones. Existing apps keep working; you just cannot make new ones. The
replacement, **Service Keys**, has been in public beta since February 2026 and **does not support
webhooks**. Both are `Authorization: Bearer pat-…`, so one code path serves both — but a design
that assumes webhooks is a design that cannot ship on the credential new users will have.
*Implication: polling, not webhooks, for v1.*

**Correction 3 — the free tier is far smaller than the folklore.**

| Free HubSpot | Limit |
|---|---|
| Contacts | 1,000 |
| Users | 2 |
| Deal pipelines | 1 |
| **Custom properties** | **10 in total, per account — not per object** |

The property cap is the load-bearing one. **CallRise cannot keep sync bookkeeping in HubSpot custom
properties.** Every mapping, every baseline, every "last synced" marker must live in CallRise's own
store. That is a constraint on the design, not a detail.

## 2. Should it be HubSpot at all? Two answers worth your attention

**Salesforce should not be first, but not for the reason you'd expect.** On raw installed base
Salesforce actually *beats* HubSpot among the smallest companies (24,431 Salesforce-CRM domains at
0–9 employees against 7,754 HubSpot; 43,832 against 19,672 at 20–49). The disqualifier is
structural: **Salesforce's SMB editions do not have an API at all.** Per Salesforce's own knowledge
article, API access ships only in Enterprise, Unlimited, Developer and Performance. Group and
Essentials cannot buy it as an add-on at any price. The cheapest edition a rep can buy that
includes the API is **$195 per user per month**. So the small-team rep who is on Salesforce is,
with high probability, on an edition CallRise literally cannot call. There is an ISV escape hatch
(Salesforce will allowlist a partner's key into Professional orgs) but it is gated on passing
AppExchange security review first — roughly $999 per submission and six to nine weeks, before the
first customer connects.

**Attio has a stronger claim to being first than HubSpot does, and it wins on your own argument.**
You said a sync that corrupts someone's CRM is the one failure that would end the product, and that
nothing may be written without your approval. Attio is the only CRM in this set where **the
credential itself can be read-only**: scopes are chosen when the key is created, with separate
`record_permission:read` and `record_permission:read-write` variants. That turns "we promise not to
write" from a property of my code into a property of the token — a guarantee no amount of careful
coding gives you, and one you can verify yourself in their UI in ten seconds. Its free plan is $0
for 3 seats and 50,000 records with API *and* webhook access included, and the credential is a
pasteable Bearer token.

**My recommendation, and it is a product decision so it is yours:** build the connector against
**Attio first** as the reference implementation, precisely because the read-only guarantee is
enforceable, then HubSpot second for reach. If reach must come first, HubSpot with a Service Key is
the right second choice — but then the read-only property is only as good as my code, and you
should hold me to a scope-verification test rather than a promise.

**Not recommended: a unified-API vendor.** Merge, Nango and Paragon each require a server-side
secret (a link token, a connect session, an RS256-signed JWT). A desktop app with no backend cannot
hold one. They fail architecturally before they fail on price.

## 3. What the competition does, and what it means for us

- **Gong** is the most aggressive and the most dangerous: its AI Data Extractor **overwrites
  existing CRM field values automatically with no approval step**, and Gong's own documentation
  notes that HubSpot's API does not check user permissions — so a Gong edit lands even when the
  user lacks rights to that field.
- **Fireflies** makes review **mandatory**: nothing reaches HubSpot until the user approves it,
  with per-field append-versus-overwrite. This is the finding that should reset expectations:
  **approval-before-write is table stakes at the price point we are targeting, not a
  differentiator.**
- **Fathom** has the safest design in the market and is worth copying outright: it never creates
  contacts, matches only on primary email, and **if a contact is not found it writes nothing.**
- The failure modes users actually complain about are concrete and all avoidable: duplicate
  meetings when two integrations sync one calendar; new contacts created but not associated to the
  existing company and with the wrong owner; notes fanning out onto the wrong deals **because
  HubSpot itself auto-associates a logged activity to the primary company plus the five most recent
  open deals**; and action-item task spam across every open opportunity.

That third one deserves emphasis: an approval card that says *"write this note to Acme Corp"* is a
lie unless it enumerates the other records HubSpot will attach it to on its own.

**One belief to drop:** "no bot in the meeting" is no longer a local-first advantage. Fathom 3.0
ships bot-free capture. What remains genuinely ours is that the transcript never leaves the machine
— only the fields the rep approves do.

## 4. THE DECISION: what happens when their data and ours disagree

Three proposals were written independently, then judged three times through different lenses
(irreversibility; the rep's actual working day; buildability in this codebase). **All three judges
chose the same winner, each scoring it 8/10.**

### The winner: **the rep is the merge function**

> When CallRise and the CRM hold different values for the same field, CallRise resolves nothing. It
> freezes both values with their provenance, shows the rep the exact before-and-after, and writes
> only what the rep clicks. A "disagreement" is defined narrowly and **by content**: both sides
> changed since the last agreed baseline **and** the normalised values still differ — so one-sided
> changes, formatting differences, and the entire first sync produce zero decisions to make.

The two rejected alternatives, so the choice is legible:

- **"The CRM is always right, with a receipt."** Its worst case is the one that killed it: CallRise
  becomes the thing that repeats the CRM's wrong answer with authority while holding the right one
  in grey text. Tuesday's call says the deal moved to Q1 and Marcus signs now; HubSpot still says
  Q4 and Dana; Wednesday's call prep briefs you on Q4 and Dana.
- **"A field ledger — provenance and recency decide."** Its worst case is unrecoverable once
  writing is on: *recency is a lie whenever a machine touched the field last.* A colleague
  hand-corrects a company name at 09:00; an enrichment integration overwrites it at 09:05 with a
  stale value and a newer timestamp; we believe the robot.

### The objection all three judges raised, and it is the important part

The winning rule is tuned so hard against false positives that **it may fire almost never.** It
requires both sides to have moved since a baseline minted at first sync — but a solo rep's CRM is
stale *precisely because nobody touches it*, which is this product's founding premise. So the
six-month-old wrong title, the departed champion, the amount renegotiated in March all sit as
pre-existing differences that never enter the queue. Day one is zero by construction, and the
distribution in steady state was never measured.

**So the rule needs its complement, and the complement is where the value actually is:** the
**disagreements list is the product**, not a badge. Day-one drift between the CRM and what your
calls actually said is the thing worth paying for, and it should surface **at call-prep time** —
the moment before you dial that contact — not on a page you have to remember to visit.

That framing is also the honest answer to your question. *What happens when their data and ours
disagree?* **Nothing happens automatically, ever. We tell you, at the moment it matters, and you
decide in one click.**

### Two safeguards that came out of the judging and should be conditions, not options

1. **Read-only enforced by the credential, and verified.** Request only read scopes, then check the
   scopes actually returned and **refuse to connect if any write scope is present.** A read-only
   design that accepts a read-write token is a read-only design in name only.
2. **No delete ever propagates outward, and that refusal is a test, not an omission.** Local
   deletion is already a tombstone that propagates to the cloud backup; there must be an explicit,
   tested refusal that it can never reach a CRM.

## 5. What I found in our own code, and one thing that needs fixing first

CRM sync is **greenfield**: there is no client, no stub, no token slot. The existing "CRM note"
feature is entirely local — it drafts a note and appends it as a comment on the local contact file.
Searching every `crm-*.ts` file for network calls returns nothing.

Two things would break, and I verified both myself rather than taking the research's word:

**Identity.** Contacts are keyed by `randomUUID()` with **no uniqueness constraint on email, phone
or name**, no merge or dedupe feature, and only linear-scan exact-match lookups. Two local contacts
can legitimately map to one CRM contact, and a write-back would flip-flop between them. There is
also a live double-source-of-truth: `Contact.dealValue` and `Contact.pipelineStage` duplicate
`Deal.value` and `Deal.stageId`.

**Egress, and this is the one to fix first.** The app's strongest privacy guard, `CALL_FIELD_RULES`,
is exhaustive over `Required<Call>` so that an unclassified field is a *compile error* rather than a
silent leak — the fix for the shape that produced BUG-014, BUG-028 and BUG-115. **It covers calls
only.** Contacts are pushed to the cloud backup as `payload: c` — the whole record — and deals as
`payload: { ...d }`. There is no `CONTACT_FIELD_RULES` and no `DEAL_FIELD_RULES`; I checked.

The consequence is concrete: **the moment a CRM identifier field is added to `Contact`, it leaves
the device on the next backup with nothing having classified it.** That is not hypothetical — it is
the mechanism of three bugs this project has already fixed once, surviving in the two record types
the fix never covered. Logged as **BUG-199**. It should be closed before any CRM identifier is
persisted, and it is worth doing on its own merits regardless of whether CRM sync is ever built.

## 6. The read path: why I did not build it tonight

The brief said *"build the read path if it's safe."* I did not, and the reason is the verification
bar rather than the safety one.

A connector cannot be driven without a real account and a real token. Creating an account is
something I must not do, and I have no credential for any of these CRMs. I could have written a
client and a mapping layer that typechecks and has unit tests against recorded fixtures — but I
would then be handing you an integration whose first contact with a real API is on your machine,
which is exactly the shape of work this project has learned not to trust. A connector that has
never made a request is not a read path; it is a guess with tests around it.

**What would let me build and drive it, in order:** you create a free Attio workspace (or use an
existing HubSpot account), generate a **read-only** key, and set it as an environment variable the
way the extraction keys are set. I then build the client, drive it against your real data
read-only, and show you the disagreements list computed from your actual 45 contacts. That is a
day's work once the credential exists, and it produces a screenshot rather than a promise.

**In the meantime the useful prerequisite is BUG-199**, which needs no credential and no decision
from you beyond approving a data-model-adjacent change.

## 7. What I did not establish

- The steady-state rate of genuine disagreements. Nobody has measured it, including the winning
  proposal's own author, and its fatal objection turns on that number.
- Whether Attio's read-only scope actually refuses a write in practice. That is a one-request test
  and it needs a token.
- HubSpot's real-world rate-limit behaviour under a first full sync of 1,000 contacts. Documented
  limits are known; observed behaviour is not.
- Whether any of the founder's 45 local contacts would match a CRM record at all, since no CRM
  account exists yet to match against.
