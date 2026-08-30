# Free-tier AI provider research — M31

**Researched 2026-08-30.** Every base URL, model id, free-tier term and
retention posture below was read from the provider's own current
documentation. Where something could not be verified, it says so — an
unverified string in this file is a string that must not be shipped.

Why this file exists: a wrong model id produces a provider card that looks
exactly like the working ones and 404s the first time someone uses it. That is
the defect class M31 spent every stage removing, so the research is written
down rather than living in a chat log.

---

## Shipped

| Provider | Models | Free tier | Retention | Notes |
|---|---|---|---|---|
| **Z.ai (GLM)** | `glm-4.5-flash` (speed), `glm-4.7-flash` (quality) | $0.00 on their pricing page, no expiry | `no-training` (Terms of Use, scoped to API users) | No free *large* model — the quality entry is their best free one, not their best. No published rate limit. |
| **Hugging Face** | `openai/gpt-oss-20b` (speed), `openai/gpt-oss-120b` (quality) | ~$0.10/month credit, no card | `unknown` | A router to ~18 downstream providers. Only ids in the catalog confirmed against a **live** endpoint. |
| **Cloudflare Workers AI** | `@cf/meta/llama-3.1-8b-instruct-fast` (speed), `@cf/openai/gpt-oss-120b` (quality) | ~10k neurons/day, resets daily, **no card** | `no-training` (explicit, on their data-usage page) | Base URL embeds the account id — hence the second field on its card. |

### The near-miss worth remembering

The first draft of the Cloudflare research carried
`@cf/meta/llama-3.1-8b-instruct-fp8-fast`. That is a **conflation of two real
but different models** — `llama-3.1-8b-instruct-fast` and
`llama-3.1-8b-instruct-fp8` both exist. It would have passed any review that
did not go and look, because it is the right shape and its parts are all real.
The shipped ids came off the individual model pages, which print the
namespaced Model ID verbatim; the summary list omits the `@cf/` prefix and
would have been wrong in a second way.

---

## Not shipped — decisions, with the reason

### Scaleway Generative APIs — **hold for a future EU / paid tier**

**Founder decision, 2026-08-30: no for now.** A mandatory card on file inside a
lane the app presents as "free" is the looks-real-isn't shape this milestone
has been deleting. **Revisit if a privacy-first provider grouping is ever
built** — on the merits it is the strongest candidate for one.

- **Base URL:** `https://api.scaleway.ai/v1` (static; the `<uuid>.ifr.fr-par`
  form is for *Dedicated* deployments — not this)
- **Free tier:** 1,000,000 tokens/month, ongoing — but **a validated payment
  method is required**, which is the disqualifier above and nothing else.
- **Privacy — the strongest evidence of any provider looked at.** Their
  data-privacy page states data is not used for training, retraining or
  improving base models, and is not accessible to the model creators; a Zero
  Data Retention policy applies by default. Paris-hosted, GDPR, not subject to
  the US CLOUD Act.
- **Compatibility is the best-documented of any candidate** — explicit
  supported *and* unsupported parameter lists. Supported: `messages`, `model`,
  `max_tokens`, `temperature`, `top_p`, `presence_penalty`, `response_format`,
  `logprobs`, `stop`, `seed`, `stream`, `tools`, `tool_choice`. **Unsupported:**
  `frequency_penalty`, `n`, `top_logprobs`, `logit_bias`, `user`.
- ⚠ `max_tokens` is listed and `max_completion_tokens` is **not** — the same
  trap Mistral already cost us. Would need `maxTokensParam: 'max_tokens'`.
- ⚠ They publish a real **EOL calendar**. `gemma-3-27b-it` and
  `devstral-2-123b-instruct-2512` are already past EOL; `pixtral-12b-2409` and
  `qwen3-coder-30b-a3b-instruct` go 2026-10-01. Any entry added here needs a
  date check, not just an existence check.
- Candidate models if revisited: `mistral-small-3.2-24b-instruct-2506` (128k),
  `gpt-oss-120b` (128k), `qwen3.5-397b-a17b` (250k).

### OVHcloud AI Endpoints — **no, and it could not be verified**

EU-hosted with a strong no-training statement, but **two load-bearing strings
could not be confirmed**: the base URL is never printed in their docs (they
route you to a per-model page in the console), and the model catalog lives
outside the docs entirely. A card is required anyway. Not shippable without
someone reading both off the console by hand.

### Cohere — **no**

Works technically (`https://api.cohere.ai/compatibility/v1`, streaming, tools,
1,000 calls/month free). Excluded on posture: their SaaS Agreement grants
Cohere rights to share API data and fine-tuning data with third parties to
improve its offerings, with no opt-out in the agreement text. It would ship
with a red **"Trains on your data"** badge, and there is no reason to add one.

---

## Eliminated — do not re-add

| Provider | Why |
|---|---|
| **GitHub Models** | **Retired 2026-07-30**; GitHub redirects to Azure AI Foundry. Every call would have 404'd — a provider card that never worked for anyone, from day one. |
| **SambaNova Cloud** | Free tier is 20 requests/minute **and 20 requests/day**. Base URL and ids are valid; the tier is not a feature. |
| **Nebius Token Factory** | Onboarding requires a billing account with a bank card; the trial is $1 for 30 days. |
| **Together AI** | The $25 signup credit was retired; there is no free tier. |
| **Alibaba Model Studio** | Base URL is workspace-scoped (`https://{WorkspaceId}...`), so there is no static string to configure. Model naming is also churning fast. |

---

## Still unverified on shipped providers

Recorded rather than quietly assumed. None blocks use; each is a thing to look
at first if the provider misbehaves.

- **Cloudflare — streaming.** Their OpenAI-compat page documents
  `/chat/completions` and `/embeddings` and never mentions streaming. Low risk
  here: every AI call this app makes is a single forced tool call, not a token
  stream (see `ai/types.ts`).
- **Cloudflare — tool calling through the compat layer.** The *model* page for
  `gpt-oss-120b` lists function calling as supported; the compat page says
  nothing. Since every call is a forced tool call, this is the one to check
  first if Cloudflare fails on real use. "Test key" exercises the real path.
- **Cloudflare — default `max_tokens` is 256.** Every call sets it explicitly,
  so it is never used — but a caller that stopped setting it would get silently
  truncated output and no error.
- **Z.ai — rate limits.** No numeric RPM/TPM published in their own docs.
  Secondary sources say one concurrent request on the free tier; unconfirmed,
  so not encoded anywhere.
- **Z.ai — whether a card gates key issuance.** Their quick-start does not say.
- **Hugging Face — downstream retention.** HF itself does not store request or
  response bodies, but inference runs at whichever provider the router picks.
  This is why the badge reads `unknown`, and it is a finding, not a gap.
