# M29 decision memo — Pricing (B1)

**Status:** DECISION MEMO. No price, tier boundary, or trial shape is chosen
here. Nothing is gated in code until the founder decides. Every market number
is cited; "3P" marks third-party estimates for vendors that don't publish
prices.
**Date:** 2026-08-23. **Evidence gathered:** same day, from live pricing pages.
The full evidence report (per-vendor tables, 13 sections, every URL) is
appended as Part C.

---

## Part A — The three facts that should drive this decision

### 1. Our marginal cost per user is approximately zero. That is the superpower.

Verified against the code, not assumed:

- **Transcription is the user's own Deepgram key** (`src/main/ai-keys.ts:24,34`;
  `src/main/transcription.ts:1125` reads `DEEPGRAM_API_KEY` from the user's
  stored keys). We pay nothing per minute.
- **Every AI feature is the user's own key** — OpenAI, Anthropic, Gemini, Groq,
  OpenRouter (`ai-keys.ts`). We pay nothing per request.
- **What we do pay:** Supabase (auth + cloud backup; free tier today, Pro is
  $25/mo when storage outgrows 1 GB), GitHub (free), and Stripe's 2.9% + $0.30
  per transaction once billing exists. Cloud backup is the one feature whose
  cost scales with users — a user backing up calls, attachments and a
  `memory.db` might hold 10–100 MB, so ~100 active users likely pushes us to
  Supabase Pro. That's $0.25/user/month at worst.

Every competitor in the evidence report carries per-seat AI cost in their
price. Fathom, Fireflies and Otter have *free tiers* that they subsidise. We
can offer more for less and still have a higher margin, or match their prices
at a margin nobody else has.

### 2. The user's hidden cost is real but small — and zero for a long time.

With their own keys, a rep doing 20 hours of calls a month pays (Part C §13):

| Line | Monthly at list | With free credits |
|---|---|---|
| Deepgram streaming (1,200 min) | $6–11 | **$0 for ~21 months** ($200 signup credit, no card) |
| LLM, ~200 requests, Haiku/4o-mini class | $0.10–3 | $0 on Gemini/Groq free tiers (the app is already built for this: BUG-058's bar is "1–2 free-tier keys must be enough") |
| **Total** | **$6–14** | **$0 to start** |

So "you bring the keys" does not mean "you pay $50 on top." It means roughly
a coffee a month, after a long free runway. **The onboarding (B3) has to say
this out loud** — "this costs you about $0 for the first year" is a selling
line, not a caveat — and the fear to design against is not cost but friction:
"asking a developer to paste a key is easy; asking a sales rep is a barrier"
(Part C §11). That friction is the single biggest threat to any pricing
model we pick, which is why B3's guided key flow is the make-or-break.

### 3. There is no usage data yet. Tier boundaries are reasoning, not evidence.

No telemetry exists (Part C and the M29 audit). We do not know which features
people use. Workstream A3 is designed to answer exactly this. **Recommendation
baked into every option below: launch with a simple structure, and revisit
the tier boundary 60 days after A3 ships, with data.** Don't over-engineer
tiers for a product with a handful of installs.

---

## Part B — Where the market is (one screen)

| Segment | Who | Per seat / month (annual) | Trial shape | What they're selling |
|---|---|---|---|---|
| **Meeting notetakers** | Fathom, Fireflies, Otter, tl;dv, Krisp, Granola | **$8–25** | Freemium (perpetual free tier), sometimes 7-day trial; 14–90-day refund windows | Recording + summary, team search, CRM sync |
| **Sales coaching, SMB** | Avoma (+CI add-on), Salesroom | **$19–50** | 14-day no-card trial | Coaching metrics, deal views |
| **Enterprise revenue intelligence** | Gong, Chorus, Clari Copilot, Attention | **$90–160 + $5K–50K platform fee** (3P) | Demo only, annual contracts | Whole-org analytics, forecasting |
| **Real-time AI sales coaching (our closest positioning)** | Nimitai | **$119 annual / $149 monthly; $99 lifetime "founding" seat**, 14-day trial | 14-day | Live coaching, MEDDPICC scoring, CRM sync |
| **BYO-key desktop software (our closest *model*)** | TypingMind, BoltAI, MacWhisper, VoiceInk, Msty | **$39–99 one-time**, or **free-BYOK + $7–15/mo hosted** (Obsidian Copilot, Anarlog, Elephas) | Free builds + 14–30-day refunds; 7-day trials | The software, not the AI |

Two patterns from the BYO-key world worth holding onto (Part C §10–11):

- Almost nobody sells "BYOK-only, one recurring price." The observed shapes are
  (a) one-time license, (b) free BYOK tier + paid *hosted* tier, (c) BYOK as a
  *premium* feature. TypingMind (one-time BYOK license) reached ~$1M lifetime
  revenue but then **added** a recurring Teams tier — the "year two" problem
  is real: a one-time license gives away the recurring revenue.
- The "pay $200 for a tool that costs $8 of API" objection is exactly what BYO
  neutralises. Our price should be justified by what the *software* does
  (live coaching, Sales Brain, local-first privacy), not by AI cost.

Trial benchmarks (200 self-serve B2B products, Jan 2026, Part C §12): 14-day
trials are 62% of the market; no-card trials convert 4–6% ("great" 10–15%);
**card-required trials convert 25–35%** but get far fewer sign-ups; freemium
3–5%. AI products are converting better than classic SaaS.

---

## Part C-0 — The feature inventory to price (what the app actually has)

Grouped by what a stranger would perceive as "the thing I'd pay for":

| Group | Features |
|---|---|
| **Core call** | Live transcription with speaker labels, saved calls, post-call summary, AI tasks, post-call brief, consent flow, noise cancellation (Windows Tier 1, driver-free) |
| **Live coaching** | Real-time cues, battlecards, talk-ratio meter, question checklist, commitment extractor, custom trackers, scorecards, coaching chat, practice mode, PDF export |
| **Intelligence** | Sales Brain (local memory + retrieval), Rise (AI chat, M28 — unshipped), contact intelligence, deal intelligence (Tier 0/1/2), prep briefs, objection library/mining |
| **Workflow** | CRM (contacts, deals, notes, CRM-note generator), tasks, calendar (Google + Outlook two-way), knowledge base, analytics |
| **Cloud** | Cloud backup + restore (the one feature that costs us money), scheduled alerts (built, **never deployed** — see audit) |
| **Team** | Does not exist yet (a "team" feature folder exists; multi-seat licensing must not be precluded — see B2 note at the end) |

---

## Part D — Three structures (the founder picks)

Prices are shown as **candidate ranges anchored to the evidence**, not
proposals. The founder sets the number.

### Option 1 — "Free forever for the call, pay for the brain" (freemium)

| | Free | Pro |
|---|---|---|
| Price | $0 | candidate range **$15–29/seat/mo** (sits between Fathom/Fireflies Pro and Avoma Startup; well under Nimitai) |
| Core call | ✅ all of it | ✅ |
| Live coaching | ✅ cues + scorecards | ✅ + coaching chat, practice mode, custom trackers, PDF |
| Intelligence | ❌ (Sales Brain off, Rise off, prep briefs off) | ✅ |
| Workflow | ✅ CRM, tasks, calendar | ✅ |
| Cloud backup | ❌ | ✅ |
| Keys | BYO | BYO |

- **Why it fits us:** the free tier costs us *nothing* (no cloud, no AI) and it
  is still a genuinely good product — better than a notetaker's free tier.
  That is a marketing weapon competitors can't copy.
- **Why it might not:** freemium converts 3–5% and needs volume we don't have.
  The features we'd withhold (Sales Brain, Rise) are the hardest to explain to
  a stranger in a pricing table, so the upgrade reason is abstract until they
  feel it.
- **Trial shape:** none needed — or a **14-day reverse trial** (everything on
  for 14 days, then drop to Free). Reverse trial is what makes "feel the Sales
  Brain" happen.

### Option 2 — "One product, one price, try it properly" (trial → paid)

| | Trial (14 days) | Pro |
|---|---|---|
| Price | $0, no card | candidate range **$19–39/seat/mo**, annual ~40% off (market norm is 40–50%) |
| Everything | ✅ | ✅ |
| Keys | BYO | BYO |
| After trial | App stays **usable for viewing** (past calls, CRM, tasks, calendar — your data is yours) but live calls/AI stop until you subscribe | |

- **Why it fits us:** simplest to build (one gate: `isEntitled('pro')`), simplest
  to explain, no permanent free-rider cost, highest conversion of the
  self-serve shapes. Matches Avoma/Nimitai/Krisp's shape.
- **Why it might not:** a rep who hits the wall on day 15 mid-quarter is lost
  if the value didn't land inside 14 days — and with today's onboarding it
  won't (audit §4). Option 2 is only right **after** B3 onboarding exists.
- **Trial shape decision inside this option:** no-card (more sign-ups, 4–6%
  convert) vs card-required (fewer, 25–35%). For a desktop app from an unknown
  founder, **no-card** — asking for a card before trust exists is the
  SmartScreen warning all over again.
- **Optional:** a "Founding" price (Nimitai does $99 lifetime, cap 500;
  TypingMind launched at $9 and went to $79). A lifetime deal converts the
  first hundred believers and funds nothing recurring — fine at our size,
  but cap it.

### Option 3 — "License the software, subscribe to the cloud" (hybrid)

| | Free (BYOK) | License (one-time) | Cloud (subscription) |
|---|---|---|---|
| Price | $0 | candidate range **$79–149 one-time**, 1 yr of updates (BoltAI/TypingMind/Msty shape) | candidate range **$8–15/mo** (Anarlog/Obsidian Copilot shape) |
| Core call + coaching | ✅ limited (e.g. 10 calls/mo) | ✅ all, forever | ✅ |
| Intelligence | ❌ | ✅ | ✅ |
| Cloud backup, multi-device | ❌ | ❌ | ✅ |
| Managed AI (we provide keys) | ❌ | ❌ | optional add-on, see Part E |

- **Why it fits us:** it is the honest shape of what we are — local software
  plus an optional cloud. Perpetual licensing is *the* trust statement for a
  privacy-first desktop app ("you own it; if we vanish it keeps working").
  Cloud and managed-AI are the recurring line, priced at their cost + margin.
- **Why it might not:** three things to explain; "year two" revenue depends on
  the cloud tier being wanted; renewals for updates are a support burden.
  It's the most work in B2 (two entitlement kinds, `license` and `cloud`).

### Recommendation (structure + trial, not price)

**Option 2 now, evolving toward Option 3's split once A3 data exists**,
specifically:

1. **Ship one paid tier ("Pro") with a 14-day, no-card, full-featured trial**
   and an honest post-trial state (view everything, live/AI features wait).
   One gate, one helper, one sentence on the pricing page.
2. **Price it as software, not as AI** — anchored in the $19–39 band, i.e.
   above notetakers (we do live coaching, they don't) and far below Nimitai
   (we're BYO and unproven). The founder picks the number; the memo's only
   strong opinion is **don't go below the notetakers** — under $15 says
   "notetaker," and we are not one.
3. **Offer annual at the market-standard 40% off** and a capped Founding
   deal if the founder wants early believers locked in.
4. **Do not build Free-tier gating now.** A permanent free tier is a second
   product to support; decide on it at the 60-day A3 review when we know what
   people actually use. Option 1's "free forever for the call" remains
   available then, and the entitlement design (B2) must not preclude it.
5. **Managed AI stays a memo item** (Part E). Not in v1 of billing.

Reasons this is the recommendation and not Option 1 or 3 today: we have no
usage data (Option 1 needs it to draw the line), no team features (Option 3's
cloud tier is thin without multi-device/team), and a tiny install base
(volume-dependent freemium math doesn't apply yet). Option 2 is the smallest
honest thing that produces a price and a conversion number we can learn from.

**Hard dependency:** Option 2 is wrong to launch before B3 onboarding exists.
A 14-day trial against today's first run (audit §4) burns the trial before
the user has a working key. Sequence: B3 → B2 → announce pricing.

---

## Part E — "Managed AI quota on the paid tier" (priced-out scenario, NOT a build item)

The idea: a paid tier where **we** hold the Deepgram + LLM keys, so the user
never sees the words "API key." It breaks the no-new-services rule
(Deepgram + an LLM vendor become *our* vendors), so it is a memo item only.

**Cost to us, per seat per month** (Part C §13, list prices, no volume deal):

| Usage profile | Deepgram | LLM (Haiku/4o-mini) | LLM (Sonnet-class) | Total |
|---|---|---|---|---|
| Light (10 h calls) | $5 | $0.10 | $1.50 | **~$5–7** |
| Typical (20 h) | $9 | $0.20 | $3 | **~$9–12** |
| Heavy (40 h, live cues every minute) | $18 | $2 | $18 | **~$20–36** |

**What we'd have to charge:** to keep a 70% gross margin on the *typical*
profile, the managed add-on alone is **$30–40/mo** — and the heavy tail
(p99 agent-loop costs were 80× the median in one dataset, Part C §11) means
either a hard minutes cap or a loss on power users. Every notetaker in Part B
solves this with minute caps (Otter: 1,200 min/mo on Pro), and so would we.

**Three costs beyond money:**

1. **Brand.** With BYO keys, the user's audio goes to Deepgram under *their*
   account. With managed keys it goes under *ours* — we become a party to
   their call audio in a vendor's logs. "Your data stays on your machine"
   becomes "…and passes through our Deepgram account." That sentence must
   change on the website if we do this. It's defensible (zero retention
   settings exist) but it is a different promise.
2. **Ops.** Key rotation, abuse (a leaked managed key is our bill), rate
   limits across all users, and a vendor outage becoming *our* outage for
   every paying user at once — the exact failure the BYO design avoids.
3. **Support.** "Why did my minutes run out" replaces "how do I get a key."

**When it becomes worth it:** if B3's guided key flow, tested on strangers,
still loses most of them at the key step. That is measurable (A3: onboarding
step-completion counters). Decide then, with the number, not now.

---

## Part F — Decisions for the founder

| # | Decision | Options | Memo's lean |
|---|---|---|---|
| 1 | Structure | Option 1 / **2** / 3 | 2 now, revisit at 60 days of A3 data |
| 2 | Trial | 14-day no-card / 14-day card-required / freemium / reverse trial | 14-day, no card, full-featured |
| 3 | Post-trial state | Read-only your-data vs. fully locked | Read-only (your data is yours — brand) |
| 4 | Monthly price | founder's number; evidence band $19–39 | not below the notetakers |
| 5 | Annual discount | 0–50% | 40% (market norm) |
| 6 | Founding/lifetime deal | none / capped lifetime / locked-in price | capped, if at all |
| 7 | Managed AI | build later / never / now (breaks rule) | later, triggered by B3 data |
| 8 | Free tier | none now / Option 1 later | decide at the 60-day review |
| 9 | Refund window | none / 14 / 30 days | 30 days (BoltAI/Superwhisper norm; cheap at our cost base) |

## Part G — What B2 must not preclude (from this memo)

- **Multi-seat / team licences** (not this milestone): the entitlement token
  should carry `seats` and an `org` slot even if both are 1/null today.
- **A free tier later:** `isEntitled(feature)` must work with a plan named
  `free`, not assume "no subscription = no access."
- **A one-time licence later (Option 3):** an entitlement with no
  `current_period_end` must be representable (perpetual).
- **Managed AI later:** an entitlement flag `managedAi: boolean` that today
  is always false and nothing reads.

---

# Part C — Evidence report (verbatim, compiled 2026-08-23)

Every number below has a URL. "Official" = vendor's own pricing page fetched
today; "3P" = third-party estimate with its date.

## C.1 Gong

| Field | Value | Source |
|---|---|---|
| Public price | **None — contact sales.** "Licenses are priced per user" + "a platform fee based on the number of users." | [gong.io/pricing](https://www.gong.io/pricing) (official) |
| Per-seat (3P) | $1,200–2,400/seat/yr; median contract $54,900/yr across 1,128 purchases | [Vendr](https://www.vendr.com/marketplace/gong) (Mar 2026) |
| Per-seat (3P) | $1,300–1,920/user/yr; bundles $2,400–3,000 | [MarketBetter](https://marketbetter.ai/blog/gong-pricing-breakdown-2026/) (Feb 2026, updated Aug 2026) |
| Platform fee (3P) | $5,000–50,000/yr; small teams ~$5,000 | MarketBetter |
| Implementation (3P) | $15,000–25,000 for <20 users | MarketBetter |
| Trial | Demo-only; annual contracts only | MarketBetter |
| Per-seat/month equivalent | ~$108–160 (before platform fee) | derived |

## C.2 Chorus.ai (ZoomInfo)

| Field | Value | Source |
|---|---|---|
| Public price | None — demo/contact sales | [zoominfo.com/products/chorus](https://www.zoominfo.com/products/chorus) |
| Estimate (3P) | ~$8,000/yr base incl. 3 seats + ~$1,200/yr per extra seat; 3-seat minimum | [Claap](https://www.claap.io/blog/chorus-pricing) (Aug 20, 2026); [MarketBetter](https://marketbetter.ai/blog/chorus-ai-pricing-breakdown-2026/) |
| Per-seat/month | ~$222 at 3 seats; ~$100 marginal | derived |
| Flag | Vendr page 404; no transaction-backed data | — |

## C.3 Krisp (official tiers are Core / Advanced)

| Plan | Monthly | Annual (per mo) | Contents |
|---|---|---|---|
| Free trial | $0 | — | 7 days, no card |
| Core | $16/user | $8/user | AI notetaker + noise cancellation, integrations, 10 GB |
| Advanced | $30/user | $15/user | + Salesforce, admin, 60 GB |
| Enterprise | custom | custom | SSO/SCIM, on-device transcription, HIPAA |

Source: [krisp.ai/pricing](https://krisp.ai/pricing/) (official). Flag: 3P
pages still describe a perpetual free plan; the official page today shows a
7-day trial.

## C.4 Fathom

| Plan | Monthly | Annual (per mo) | Notes |
|---|---|---|---|
| Free | $0 | $0 | "Free forever," unlimited recordings, basic summaries |
| Premium | $20 | $16 | advanced summaries, action items |
| Team | $19 | $15 | 2-seat minimum |
| Business | $34 | $25 | CRM field sync, coaching metrics |

Source: [fathom.ai/pricing](https://fathom.ai/pricing) (official). 90-day
money-back guarantee.

## C.5 Fireflies.ai

| Plan | Monthly | Annual (per mo) | Notes |
|---|---|---|---|
| Free | $0 | $0 | unlimited transcription + summaries, 400 min storage |
| Pro | $18 | $10 | 8,000 min storage/seat |
| Business | $29 | $19 | unlimited storage, conversation intelligence |
| Enterprise | — | $39 (annual only) | SSO/SCIM, HIPAA |

Source: [fireflies.ai/pricing](https://fireflies.ai/pricing) (official).
Freemium only, no timed trial.

## C.6 Otter.ai

| Plan | Monthly | Annual (per mo) | Limits |
|---|---|---|---|
| Basic | $0 | $0 | 300 min/mo |
| Pro | $16.99 | $8.33 | 1,200 min/mo |
| Business | $30 | $19.99 | unlimited |

Source: [otter.ai/pricing](https://otter.ai/pricing) (official).

## C.7 tl;dv (official page 404 — 3P only)

Free (10 AI notes lifetime) / Pro $29 monthly, $18 annual / Business $98
monthly, $59 annual. Source: [Claap](https://www.claap.io/blog/tl-dv-pricing)
(Aug 20, 2026).

## C.8 Nimitai

$149/seat/mo monthly, $119 annual, **$99 lifetime founding seat (cap 500)**,
14-day trial, no seat minimum, volume discounts at 25/50/100. Site says
"currently in private beta." Source: [nimitai.com/pricing](https://nimitai.com/pricing)
(official).

## C.9 One-liners

| Product | Price | Trial | Source |
|---|---|---|---|
| Attention | Contact vendor; 3P guess $100–200/user/mo | none | [Capterra](https://www.capterra.com/p/10037773/Attention/) |
| Clari Copilot | Quote; Capterra lists $1,080 / $1,320 per user/yr; 3P standalone $120–160/mo | free trial, no card | [clari.com/pricing](https://www.clari.com/pricing/); [Capterra](https://www.capterra.com/p/194117/Wingman/pricing) |
| Avoma | Startup $19 annual / $29 monthly; Conversation Intelligence add-on $29/$35; Startup+CI ≈ $48 | 14-day, no card | [avoma.com/pricing](https://www.avoma.com/pricing) |
| Salesroom | Team $49, Growth $79 /user/mo | free trial | [Capterra](https://www.capterra.com/p/10015576/Salesroom/) |
| Granola | Business $14/user/mo; free 25-note cap | freemium | [granola.ai/pricing](https://granola.ai/pricing) |

## C.10 Local-first / BYO-key desktop analogues

| Product | Model | Price | BYOK | Source |
|---|---|---|---|---|
| Jan.ai | free, open source | $0 | yes | [jan.ai](https://www.jan.ai/) |
| TypingMind | one-time license + Teams sub | $39 / $79 / $99 one-time; Teams from $99/mo per 5 seats | yes | [typingmind.com](https://www.typingmind.com/); [review](https://diyai.io/ai-tools/productivity/reviews/typingmind-review/) (Jul 2026) |
| Msty Studio | free + annual/lifetime | Aurum $149/yr; Lifetime $349 | yes + local | [msty.ai/pricing](https://msty.ai/pricing/) |
| BoltAI | perpetual, 1 yr updates | Essential $79, Pro $99, Team $99/seat (5 min); 30-day refund | "BYOK by default" | [boltai.com/pricing](https://boltai.com/pricing) |
| Superwhisper | freemium + sub/lifetime | Pro $8.49/mo, $84.99/yr, $249.99 lifetime | Pro-only | [3P](https://usevoicy.com/blog/superwhisper-pricing) (Jun 2026) |
| MacWhisper | one-time | €59 Pro lifetime; App Store $6.99/mo | yes | [3P](https://www.getvoibe.com/resources/macwhisper-pricing/) (Jul 2026) |
| VoiceInk | one-time | $29 / $49 / $69 (Aug 2026) | yes | [3P](https://www.getvoibe.com/resources/voiceink-pricing/) |
| Elephas | sub with credits + BYOK unlimited | $19 / $39 / $49 per mo; 7-day trial | yes | [elephas.app/pricing](https://elephas.app/pricing) |
| Copilot for Obsidian | free BYOK + paid hosted | Free; Lite $7.99; Plus $14.99; $349.99 lifetime | free tier is BYOK | [obsidiancopilot.com/pricing](https://www.obsidiancopilot.com/en/pricing) |
| Anarlog (ex-Hyprnote) — closest analogue: local-first notetaker | free BYOK + paid hosted | Free unlimited local + BYOK; Pro $15/mo or $150/yr | yes | [anarlog.so/pricing](https://anarlog.so/pricing) (verified Aug 11, 2026) |

## C.11 BYO-key as a pricing model — evidence

1. TypingMind: $22K first 11 days, ~$500K year one, ~$1M lifetime by Nov 2024,
   $83K/mo Oct 2024; license went $9 → $39–79; then **added** a recurring
   Teams tier. [Starter Story](https://www.starterstory.com/typingmind-breakdown);
   [GetLatka](https://getlatka.com/companies/typingmind). No conversion data.
2. Indie Hackers, Feb 2026: a $150/mo SaaS pivoted to $99 one-time BYOK;
   commenters said $99 was underpriced ($199–249 suggested); trust/permanence
   cited as the real value. [Thread](https://www.indiehackers.com/post/i-pivoted-from-150-mo-saas-to-a-99-one-time-self-hosted-model-1dd70ff8f6)
3. Indie Hackers, May 2026: light users pay 3–5× markup on AI subscriptions;
   annual discounts deepened to 40–50%; p99 agent-loop cost $34.80 vs median
   $0.42 — BYOK shifts tail risk to the user. [Thread](https://www.indiehackers.com/post/the-uncomfortable-truth-about-ai-tool-pricing-in-2026-92944b6a4d)
4. Trends.vc (403, snippet only, unverified): "what does a BYOK app do in year
   two to rebuild the revenue it gave away?" [Link](https://trends.vc/bring-your-own-key-byok-apps-spend-caps-perpetual-pricing-provider-terms/)
5. Cursor did **not** kill BYOK — it's a hybrid (BYOK for chat, managed for
   Tab/Agent). [Cursor docs](https://cursor.com/help/models-and-usage/api-keys)
6. No published A/B or cohort data comparing BYOK vs managed conversion or
   churn was found. The qualitative consensus: BYOK removes the "$200 tool on
   $8 of API" objection and the shutdown-risk objection; "asking a marketing
   manager to paste a key is a barrier." ([buildmvpfast](https://www.buildmvpfast.com/blog/byok-bring-your-own-key-ai-saas-pricing-model-2026), [LockLLM](https://www.lockllm.com/blog/BYOK-vs-managed-keys))

## C.12 Trial conventions 2025–2026

200 self-serve B2B products, Jan 2026 ([ChartMogul](https://chartmogul.com/reports/saas-conversion-report/); [Growth Unhinged](https://www.growthunhinged.com/p/free-to-paid-conversion-report)):

| Model | Good | Great |
|---|---|---|
| Freemium | 3–5% | 8–12% |
| Free trial, no card | 4–6% | 10–15% |
| Reverse trial | 4–6% | 8–12% |
| Free trial, card required | 25–35% | 50–60% |

14-day trials = 62% of trial products; 7-day 14%; 30-day 14%. AI products
convert better than classic SaaS ([Poyar](https://substack.com/@kylepoyar/note/c-209940962)).
Desktop indie norm: 7-day trials + 30-day refund windows; Mac App Store
minimum 3-day trial. Claims like "7-day beats 30-day by 71%" trace to
aggregators with no named dataset — treat as noise.

## C.13 The hidden cost to a BYO-key user

Assumptions: 20 h calls = 1,200 streaming minutes; 200 LLM requests at ~4K in
/ 500 out tokens (0.8M/0.1M); heavy case 2M/0.2M.

**Deepgram Nova-3** ([deepgram.com/pricing](https://deepgram.com/pricing), official):
streaming monolingual $0.0077/min regular ($9.24) / $0.0048 promo ($5.76);
$200 signup credit, no card → ~26,000 min ≈ 21 months of this workload free.

**LLM (200 req/mo):** GPT-4o mini $0.18 (heavy $0.42); Claude Haiku 4.5 $1.30
(heavy $3.00); Claude Sonnet 5 $2.60 (heavy $6.00); Gemini 2.5 Flash-Lite
$0.12. Sources: [OpenAI](https://developers.openai.com/api/docs/pricing),
[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing),
[Google](https://ai.google.dev/gemini-api/docs/pricing).

**Per seat:** STT $6–11 + LLM $0.10–3 ≈ **$6–14/mo at list; $0 for ~1.5–2
years with credits.** Gong's per-seat price is 10–20× this.

## C.14 Summary — per-seat monthly, low to high (annual billing)

| Product | Cheapest paid (annual, per mo) | Free tier? | Trial |
|---|---|---|---|
| Jan.ai | $0 | all | — |
| Anarlog | $0 BYOK; Pro $12.50 | yes | free tier |
| Copilot for Obsidian | $0 BYOK; Lite $6.25 | yes | 14-day refund |
| VoiceInk / TypingMind / MacWhisper / BoltAI | $29–99 one-time | varies | refunds |
| Superwhisper | $7.08 | yes | 30-day refund |
| Krisp Core | $8 | trial only | 7-day |
| Otter Pro | $8.33 | yes | freemium |
| Fireflies Pro | $10 | yes | freemium |
| Msty Aurum | $12.42 | yes | free tier |
| Granola Business | $14 | yes | freemium |
| Krisp Advanced / Fathom Team | $15 | — / yes | 7-day / refund |
| Elephas / Fathom Premium | ~$16 | yes | 7-day / refund |
| tl;dv Pro | $18 | yes | freemium |
| Avoma Startup / Fireflies Business / Otter Business | $19–20 | varies | 14-day / freemium |
| Fathom Business | $25 | yes | refund |
| Fireflies Enterprise / Avoma Enterprise | $39 | — | — |
| Avoma Startup + CI | ~$48 | — | 14-day |
| Salesroom Team | $49 | no | trial |
| tl;dv Business | $59 | yes | freemium |
| Clari Copilot (3P) | ~$90–160 | no | trial |
| Chorus (3P) | ~$100 marginal; ~$222 effective at minimum | no | sales-assisted |
| Gong (3P) | ~$108–160 + $5K–50K platform fee | no | demo |
| Nimitai | $119; $99 lifetime founding | no | 14-day |

## C.15 Flags — not verified

tl;dv (official 404), Attention (404), Salesroom (TLS failure), Superwhisper
(official page garbled), TypingMind/Screenpipe (JS-rendered), Anarlog (blog
contradicts pricing page; pricing page is newer), Krisp (3P describe a free
plan the official page no longer shows), Chorus (Vendr 404), Trends.vc (403),
all contact-sales vendors (every dollar is 3P), and every "7-day beats 30-day"
aggregator claim.
