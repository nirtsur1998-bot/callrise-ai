# One paid text-AI provider for CallRise AI — priced, checked, and costed (2026-09-08)

## First: two premise checks before the provider choice

**1. The six jobs described do not need tool calling at all.** Every one of them — summary, coaching report, title, memory extraction, live cue — is "return one JSON object matching this schema." That is *structured output*, not tool use. On every provider surveyed, strict structured output is the guaranteed path and tool calling is the weaker one:

- Groq's own docs: strict mode gives "100% schema adherence" via constrained decoding — and **"Streaming and tool use are not currently supported with Structured Outputs"** ([Groq structured outputs](https://console.groq.com/docs/structured-outputs)). So on Groq, a tool call is *by construction* best-effort. The measured ~40% failure rate is consistent with that, and **upgrading to Groq paid would not fix it** — only switching from tool calls to `response_format` would, at the cost of streaming.
- Anthropic documents the two as separate features: `output_config.format` (JSON outputs) and `strict: true` (strict tool use), both constrained-decoded ([Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).
- OpenAI: `strict: true` "will ensure function calls reliably adhere to the function schema, instead of being best effort" ([function calling](https://developers.openai.com/api/docs/guides/function-calling)).

Switching from tool-calls to strict structured output is plausibly a larger reliability win than switching provider, and it costs nothing. Do it regardless of which provider wins.

**2. "Pay for ONE provider" changes the key model.** Today the app uses *user-supplied* keys. A single company-paid key in a shipped Electron app is extractable — `app.asar` unpacks trivially, which this repo already knows. Consolidating means either a small proxy the founder runs (adds an always-on server + a place where buyer PII transits) or an embedded key that will leak. That decision is upstream of the provider choice and is not costed below.

Also relevant: call audio already streams to Deepgram on every call, so a text-AI subprocessor is *not* the first place buyer PII leaves the machine. It is an additional subprocessor, and the choice of which one still matters a great deal (see DeepSeek).

---

## Workload model used for every cost figure

Stated explicitly so the numbers can be audited. Per call, adding ~300 tokens of system prompt + schema to each non-cue request:

| Job | Calls | Input each | Output each |
|---|---|---|---|
| Summary | 1 | 3,000 | 500 |
| Coaching report | 1 | 3,000 | 1,200 |
| Title | 1 | 3,000 | 60 |
| Memory extraction | 4 | 1,000 | 300 |
| Live cue | 30 | 1,500 | 100 |

**Per call: 58,000 in / 5,960 out. Per month (200 calls): 11.6M in / 1.192M out.**

The single most important structural fact: **the live cues are 78% of all input tokens** (45,000 of 58,000 per call). Everything about cost is really about that leg. It is also the latency-sensitive one, so it cannot be batched — but it *can* be prompt-cached, since 30 requests inside one call share a large prefix.

---

## Per-provider findings

### Anthropic — Claude Haiku 4.5
- **Price: $1.00 / $5.00 per MTok.** Batch $0.50/$2.50; cache write (5m) $1.25; cache read $0.10. [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- **Structured output: guaranteed.** Constrained decoding; docs say "Always valid… no retries needed for schema violations." `claude-haiku-4-5-20251001` is explicitly on the supported list, as is Sonnet 5. Both `output_config.format` and `strict: true` tool use. Limits: no numeric/string constraints (`minimum`, `maxLength`), no recursion, no external `$ref`, `additionalProperties: false` required. [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- **Entry paid tier ("Start"): 1,000 RPM / 2,000,000 ITPM / 400,000 OTPM on Haiku 4.5**, $500/mo spend cap. Cache reads do *not* count toward ITPM. This is by far the most generous entry tier in the survey. [rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- **Data: "We do not use API data for training (unless you have an agreement with us that states otherwise)."** Zero-data-retention agreements exist for some customers. [privacy.claude.com](https://privacy.claude.com/en/articles/7996875-can-you-delete-data-that-i-send-via-api)
- **Tokenizer note that affects the comparison:** Claude 4.7-and-later models use a newer tokenizer producing ~30% more tokens for the same text. Haiku 4.5 uses the *previous* tokenizer, so its $1/$5 is apples-to-apples with OpenAI/Gemini token counts; Sonnet 5's $2/$10 effectively is not.
- Sonnet 5 for reference: **$2.00 / $10.00** — same API, same key, same schemas, if the coaching report alone needs more model.

### OpenAI — gpt-5.6-luna (cheapest current-gen with both features)
- **Price: $0.20 in / $0.02 cached / $1.20 out per MTok.** [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing), [model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- Other tiers: gpt-5-mini $0.25/$2.00, gpt-5-nano $0.05/$0.40, gpt-5.4-mini $0.75/$4.50, gpt-5.4-nano $0.20/$1.25, gpt-5.6-terra $2.00/$12.00, gpt-6-astra $10/$50 (same pricing page).
- **Structured output: guaranteed**, with named caveats — refusals, safety denials, or hitting the token cap can still produce a non-conforming response. Strict function calling requires `additionalProperties: false` and every field `required` (optional fields via `["string","null"]`). [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- **Entry tier: Tier 1 is $5 paid; gpt-5.6-luna Tier 1 = 500 RPM / 500,000 TPM.** Tier 2 ($50 paid) = 5,000 RPM / 2M TPM. [rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
- **Data: not used for training by default; abuse-monitoring logs retained up to 30 days.** ZDR exists for `/v1/chat/completions` and `/v1/embeddings` but requires OpenAI's prior approval. [your data](https://developers.openai.com/api/docs/guides/your-data)

### Google — Gemini paid Flash tiers
- **Gemini 3.8 / 3.7 / 3.6 Flash: $0.75 / $3.75 through 2026-12-31, then $1.50 / $7.50 from 2027-01-01.** That scheduled doubling is a real budgeting trap.
- **Gemini 3.1 Flash-Lite: $0.25 / $1.50. Gemini 3.5 Flash-Lite: $0.30 / $2.50. Gemini 2.5 Flash-Lite: $0.10 / $0.40.** [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing)
- **Structured output: weakest guarantee language of the three majors.** The docs warn "Not all JSON Schema features are supported," "very large or deeply nested schemas may be rejected," and explicitly tell you to "always validate values in your application" and handle "schema-compliant but semantically incorrect outputs." No constrained-decoding guarantee is stated in the same terms Anthropic and OpenAI use. [structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- **Entry paid tier limits: not published.** The docs page defers to AI Studio for actual numbers. [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- **Data: paid tier is clean** — "Google doesn't use your prompts… or responses to improve our products"; logging is limited-period and only for abuse/legal. The free tier they're on today *is* used for training and may be read by human reviewers. [terms](https://ai.google.dev/gemini-api/terms)

### DeepSeek — **disqualified on privacy**
- Price is excellent: **deepseek-v4-flash $0.22 in / $0.007 cache-hit / $0.66 out off-peak**, double at peak (peak = 01:00–04:00 and 06:00–10:00 UTC Mon–Fri), USD. [api-docs.deepseek.com pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- **But: "we directly collect, process and store your Personal Data in People's Republic of China,"** and data is used "to train and improve our technology, such as our machine learning models and algorithms." There is an opt-out right, and the API/open-platform carve-out pushes end-user disclosure responsibility onto the developer. [privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)
- For an app carrying buyer PII from sales calls, that is a no.

### Groq paid — **does not fix the actual problem**
- **gpt-oss-120b $0.15 / $0.60; gpt-oss-20b $0.075 / $0.30.** Llama 3.1 8B and Llama 3.3 70B are "Contact Sales." [console.groq.com/docs/models](https://console.groq.com/docs/models)
- **Strict schema guarantee exists on only three models** (gpt-oss-20b, gpt-oss-120b, qwen3.8-27b) — **and is incompatible with tool use and with streaming.** Everything else gets JSON-object mode (valid JSON, no schema enforcement). [structured outputs](https://console.groq.com/docs/structured-outputs)
- Free tier is what's biting them: gpt-oss-20b free = 30 RPM / 8K TPM / 1K RPD. Developer-plan numbers are not published on the docs page. [rate limits](https://console.groq.com/docs/rate-limits)
- Retention/training posture is not stated in the public privacy policy — it's pushed to the Services Agreement and DPA. [privacy policy](https://groq.com/privacy-policy/)

### Together / Fireworks (cheap-but-credible)
- Together: DeepSeek V4 Flash 0731 **$0.14 / $0.28**; GLM-5.3-Flash $0.15/$0.50; Qwen3.8 Flash $0.15/$0.47. [together.ai/pricing](https://www.together.ai/pricing)
- Fireworks: DeepSeek V4 Flash **$0.22 / $0.66**; GLM 5.3 Flash $0.15/$0.50; Nemotron 3.5 Lightning 30B $0.05/$0.20. [docs.fireworks.ai/serverless/pricing](https://docs.fireworks.ai/serverless/pricing)
- Neither page documents a schema-conformance guarantee. Both host open-weight models whose tool-calling reliability is the same class the founder is already unhappy with — the hosting changes, the model doesn't.

---

## Monthly cost for this exact workload (11.6M in / 1.192M out)

| Provider / model | Input $ | Output $ | **Total/mo** |
|---|---|---|---|
| Claude Sonnet 5 | 23.20 | 11.92 | **$35.12** |
| Gemini 3.8 Flash (from 2027-01-01) | 17.40 | 8.94 | **$26.34** |
| **Claude Haiku 4.5** | 11.60 | 5.96 | **$17.56** |
| gpt-5.4-mini | 8.70 | 5.36 | **$14.06** |
| Gemini 3.8 Flash (promo, through 2026) | 8.70 | 4.47 | **$13.17** |
| DeepSeek V4-Flash (peak) | 5.10 | 1.57 | **$6.68** |
| gpt-5-mini | 2.90 | 2.38 | **$5.28** |
| Gemini 3.1 Flash-Lite | 2.90 | 1.79 | **$4.69** |
| **gpt-5.6-luna** | 2.32 | 1.43 | **$3.75** |
| DeepSeek V4-Flash (off-peak) | 2.55 | 0.79 | **$3.34** |
| Groq gpt-oss-120b | 1.74 | 0.72 | **$2.46** |
| Fireworks GLM-5.3-Flash | 1.74 | 0.60 | **$2.34** |
| Together DeepSeek V4 Flash | 1.62 | 0.33 | **$1.96** |
| Gemini 2.5 Flash-Lite | 1.16 | 0.48 | **$1.64** |
| gpt-5-nano | 0.58 | 0.48 | **$1.06** |

**With the two levers applied to Claude Haiku 4.5:**
- Prompt-cache the live-cue prefix at a 70% hit rate: **$17.56 → ~$12.56/mo**.
- Also batch the four non-urgent legs (summary, coaching, title, memory) at 50% off: **~$9.79/mo**. Batch adds up to 24h latency, so only worth it if post-call artifacts can lag.

The whole spread between the most and least expensive credible option is **under $20/month at this volume** — roughly 20 minutes of the founder's time per month. Cost should not be the deciding variable; reliability and blast radius should.

---

## Recommendation

**Claude Haiku 4.5 — $17.56/mo list, ~$12.60 with prompt caching on the live-cue leg** — because it is the only option surveyed that pairs a documented constrained-decoding guarantee on *both* JSON output and tool arguments with an entry paid tier (1,000 RPM / 2M ITPM / 400K OTPM, $500/mo cap) this workload cannot come close to saturating, and if the coaching report alone needs a stronger model, Sonnet 5 is the same key, same SDK, same schemas — no second provider.

**Runner-up: OpenAI gpt-5.6-luna — $3.75/mo.** Same guaranteed-strict-schema story at about a fifth the price, with the same cheap→strong ladder inside one key (luna → terra → gpt-6-astra); the reasons it isn't first are the tighter entry tier (500 RPM / 500K TPM at Tier 1 vs Anthropic's 1,000 RPM / 2M ITPM) and that its coaching-report quality on 2,700-token transcripts is unmeasured at this price point.

**Before committing to either, run a bake-off, not a spec-sheet comparison.** Take 20 real transcripts, run all six jobs on Haiku 4.5 and gpt-5.6-luna with strict structured output (not tool calls), and count two things: schema failures (expect zero on both — if not, that itself is the answer) and *semantic* failures, where the JSON is valid and the content is wrong. The second number is the one no pricing page can tell you, and at a $14/month spread it is the only number that should decide this.

## Sources
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) · [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits) · [Anthropic API data](https://privacy.claude.com/en/articles/7996875-can-you-delete-data-that-i-send-via-api)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [gpt-5.6-luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) · [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) · [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) · [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits) · [OpenAI your data](https://developers.openai.com/api/docs/guides/your-data)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output) · [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) · [Gemini API terms](https://ai.google.dev/gemini-api/terms)
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) · [DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)
- [Groq models & pricing](https://console.groq.com/docs/models) · [Groq structured outputs](https://console.groq.com/docs/structured-outputs) · [Groq rate limits](https://console.groq.com/docs/rate-limits) · [Groq privacy policy](https://groq.com/privacy-policy/)
- [Together pricing](https://www.together.ai/pricing) · [Fireworks serverless pricing](https://docs.fireworks.ai/serverless/pricing)