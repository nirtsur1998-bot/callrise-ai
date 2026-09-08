# BUG-234 — scoping the structured-output migration

**2026-09-08. Every number below I read out of the code myself; file:line for each.**

## The headline, and it reverses what I told you

I said "twelve-plus call sites is not a small change". **The real count is 21 files and 25 tool
definitions — and none of them has to change.**

**This is an afternoon-to-three-days change, not a milestone.** Here is the fact that decides it:

```ts
// src/main/ai/types.ts:127
tool?: AITool
```

**Singular.** The request type has never been able to offer a model a *choice* of tools. And every
adapter forces the one tool it is given:

```ts
// providers/openai-compatible.ts:134
return req.tool ? { type: 'function', function: { name: req.tool.name } } : undefined
// providers/anthropic.ts:139
return req.tool ? { type: 'tool', name: req.tool.name } : undefined
// providers/gemini.ts:7-8  — its own comment
// "Forced single-tool-call equivalent of Anthropic's tool_choice/OpenAI's
//  tool_choice: `toolConfig.functionCallingConfig` with mode 'ANY'"
```

**So the app has never used tool calling. It has been using forced-single-tool-call as a way to
spell structured output — through the one API surface every provider guarantees least.** That is the
bug in a sentence, and it is why the fix does not reach the call sites: they are already asking the
right question, in the wrong dialect. The translation belongs where the dialect is chosen, which is
the four adapter files.

---

## What actually has to change

| # | Where | What | Size |
|---|---|---|---|
| 1 | `ai/providers/anthropic.ts` | send `output_config` instead of a forced tool when the model supports it; map the JSON back into `toolInput` | small |
| 2 | `ai/providers/openai.ts` | `response_format: { type: 'json_schema', json_schema: { strict: true, schema } }`; same mapping | small |
| 3 | `ai/providers/gemini.ts` | `responseMimeType: 'application/json'` + `responseSchema`; same mapping | small |
| 4 | `ai/providers/openai-compatible.ts` | same as OpenAI, **per-provider** — this one file serves Groq, Mistral, Cerebras, OpenRouter, Cloudflare and DeepSeek, and they do not all support it identically | **the real work** |
| 5 | `ai/model-catalog.ts` | a `supportsStructuredOutput` flag beside the existing `supportsToolCalling` | small |
| 6 | `ai/capability-needs.ts` + `complete-with-fallback.ts` | prefer structured output where available, fall back to the forced tool where not — and stop excluding tool-less models from a request that no longer needs tools | medium |
| 7 | `coach.ts:166,189` | `{ type: 'integer', minimum: 1, maximum: 5 }` — numeric constraints are the one JSON-Schema feature strict modes commonly forbid | **one line, twice** |
| 8 | 12 test files touching `tool`/`toolInput` | extend rather than rewrite; the mapping keeps `toolInput` as the result shape | medium |

**Call sites changed: zero.** They keep passing `tool`, and keep reading `result.toolInput`. The
result shape does not move.

### The schema audit, done rather than assumed

I checked all 25 tool schemas for the features strict structured output typically rejects:

```
minimum / maximum   : 2 sites, both coach.ts (scores 1-5)
maxLength           : 0 in any tool schema (the 7 hits are a local scrubber's option)
oneOf / anyOf       : 0  (the 3 "oneOf" hits are the substring in `tombstoneOf`)
$ref / recursion    : 0
patternProperties   : 0
additionalProperties: false is set 41 times — already what strict mode requires
```

**One hazard in the entire tree, and it is two lines in one file.** That is the number that decides
this is not a milestone. I expected the schema audit to be where an afternoon turned into a week; it
is not.

---

## The estimate

- **Anthropic + OpenAI paths, catalog flag, capability plumbing, coach.ts, tests: one focused day.**
  That covers the key you are buying and the obvious second.
- **The `openai-compatible` fan-out: one to two more days**, because six providers share that file
  and each has to be checked and flagged individually — and checked means *measured*, not read off a
  docs page. That is where the risk lives, and it is also the part you can defer: those providers
  keep working exactly as they do today until their flag is turned on.
- **Total: 1 day to make your paid key correct, 2-3 days to do all of it.**

**Do it in that order.** Day one makes Haiku right, which is the only provider that matters once you
have the key. The free-tier fan-out can follow at leisure, and every provider still on the old path
keeps behaving exactly as it does now.

---

## How I would verify it, since this is the whole point

The measurement that started this was 8 real calls, 3 titles. The measurement that closes it should
be the same shape and bigger:

1. **Before touching anything**, run the current implementation over 30 real calls on the new paid
   key and record the per-feature failure rate with reasons. That is the number you asked for —
   *what the failure rate is on a correct implementation* needs a baseline on a correct **key**
   first, or the two changes are confounded.
2. Then migrate, and run the same 30.
3. Report both, per feature, with the failure reasons — which the app now carries end to end
   (BUG-228), so this costs nothing to collect.

Without step 1 the result is "we changed two things and it got better", which is the shape of
finding this milestone spent itself learning not to accept.

---

## One thing that is NOT in this scope, and should be said

Fixing this does not make the app's structured output *guaranteed* — it makes it guaranteed **on
providers that offer a guarantee**. On the rest it stays best-effort, and the title's prose fallback
(BUG-231) is what covers that case. The other 24 tools have no such fallback, and after this change
most of them will not need one. **The two or three that still run on a tool-only provider will.**
That is a follow-up, and it is smaller than this one.
