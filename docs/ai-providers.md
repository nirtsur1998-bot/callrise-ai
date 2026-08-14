# AI provider abstraction

> ⚠️ **STALE — describes M17 Phase 1 only. Read `src/main/ai/` for current reality.**
> *(Flagged by the M27 Phase 4 docs audit, 2026-08-14. Left in place rather than
> deleted because the core idea it explains — one provider-neutral interface, no
> SDK imported at a call site — is still exactly right. Its specifics are not.)*
>
> Three concrete ways this document is now wrong:
>
> 1. **Two providers → EIGHT.** `AIProviderId` (`src/main/ai/types.ts`) is
>    `anthropic | openai | groq | openrouter | google | nvidia | cerebras |
>    mistral`. This file knows only the first two, so a reader would conclude
>    six shipped providers don't exist.
> 2. **`LATENCY_POLICY.maxRetries` NO LONGER EXISTS** — removed, not renamed
>    (`types.ts` says so explicitly at its definition). Retry behaviour now
>    lives in three constants with distinct jobs: `SAME_MODEL_RETRY_LIMIT`,
>    `CHAIN_BUDGET`, and `HARD_CEILING_MS`. Anyone following the "Latency
>    policy" section below would go looking for a field that isn't there.
> 3. **The whole fallback/resilience subsystem is absent here.**
>    `complete-with-fallback.ts` (chain resolution and the walk),
>    `model-cooldown.ts`, `model-pacing.ts`, `purpose-health.ts` and
>    `failure-class.ts` were built across M20 and BUG-057/058/059. A call today
>    doesn't simply hit "the active provider" — it walks a resolved chain with
>    per-model cooldowns, cross-purpose pacing, failure classification and a
>    wall-clock ceiling.
>
> The purposes listed below have also grown from five to twelve.

CallRise AI's text-AI features (coaching cues, post-call summaries, coaching
scorecards, task generation, deal-risk assessment, call titles, objection
mining) route through one provider-neutral interface in `src/main/ai/`,
instead of importing an SDK directly. Deepgram (live transcription) is a
completely separate system, untouched by any of this.

## Why

The user brings their own API key (Settings → API keys) — either Claude
(Anthropic) or ChatGPT (OpenAI). Every call site is written against the
interface, so switching providers in Settings changes what answers every one
of them without touching their code.

## The interface (`src/main/ai/types.ts`)

```ts
interface AIProvider {
  readonly id: 'anthropic' | 'openai'
  readonly displayName: string
  complete(req: AICompletionRequest): Promise<AICompletionResult>
  stream(req: AICompletionRequest): AIStreamResult
  validateKey(key: string): Promise<AIValidateKeyResult>
  listModels(): Promise<string[]>
}
```

`AICompletionRequest.purpose` (`'coaching-cue' | 'summary' | 'scorecard' |
'tasks' | 'other'`) is the one thing every call site sets instead of a raw
model string. Each provider maps `purpose` to its own concrete model
internally (see `MODEL_BY_PURPOSE` in each provider file) — callers never
hardcode a model name.

**Reality check on `complete` vs `stream`:** every real call site in this
codebase does a single forced tool-call for structured JSON output (`req.tool`
set), not free-text streaming. `stream()` is implemented on both providers for
completeness/future use, but if you're adding a new call site today, you
almost certainly want `complete()` with a `tool`.

## Latency policy — do not regress this

`LATENCY_POLICY` in `types.ts` maps each `purpose` to a `{maxRetries,
timeoutMs}`. **`coaching-cue` is `maxRetries: 0`** — this runs mid-call,
automatically, in the background; a missed cue beats a late one, and a retry
loop on a 429/529 can stack into 20+ seconds of dead air. This was fixed once
before (M9) and regressed; `src/main/ai/__tests__/latencyPolicy.test.ts`
asserts it stays 0 and that neither provider hardcodes a retry value outside
this policy. If you touch either provider file, run that test.

## API keys

Keys are stored **encrypted** via Electron's `safeStorage` (macOS Keychain /
Windows DPAPI) in `src/main/ai-keys.ts` — never plaintext, never sent to
Supabase, never logged, never exposed to the renderer beyond a masked hint
(`sk-ant-…UD2I`). `AiKeyName` covers `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`. A key takes effect on the very next AI call — no restart
needed (`getActiveAIProvider()` reads `process.env` fresh every call, never
caches a client across calls).

Which provider is *active* (not the key itself) lives in `app-settings.ts`'s
`aiProvider` field — a plain, non-secret setting, defaults to `'anthropic'` so
every existing install keeps its current behavior unchanged.

**Test key**: `window.api.aiKeys.validate(providerId, value)` → main's
`aiKeys:validate` IPC handler → `buildProviderForValidation()` → the
provider's own `validateKey()`, which does the cheapest possible round-trip
(a 1-token completion, 0 retries) against a key that may not be saved yet.

## Adding a third provider

1. Create `src/main/ai/providers/yourprovider.ts` implementing `AIProvider`.
   Copy `openai.ts` as the template — it's the more recently written of the
   two and has the clearer separation between "adapt the generic request"
   and "call the SDK."
2. Add `'yourprovider'` to `AIProviderId` in `types.ts`.
3. Add its key name to `AiKeyName`/`KEY_NAMES` in `ai-keys.ts`.
4. Wire it into `getAIProvider()`/`buildProviderForValidation()` in
   `src/main/ai/index.ts`.
5. Add a `KeyCardConfig` entry (with `providerId`) in
   `src/renderer/src/features/settings/ApiKeysSection.tsx`, and an option in
   `PROVIDER_OPTIONS`.
6. Extend the preload types (`AiKeyName`, `AiProviderId` in
   `src/preload/index.d.ts`) and the `aiKeys`/`settings` bridges in
   `src/preload/index.ts`.
7. Run `src/main/ai/__tests__/latencyPolicy.test.ts` — it scans every
   provider file, so a new one needs to read `policy.maxRetries` too, not
   hardcode a nonzero retry count.

## What's deliberately NOT abstracted

- **Deepgram** — a completely different kind of API (streaming audio →
  transcript), no relationship to text completion. Not touched by this layer.
- **PDF/document input** — `AICompletionRequest.document` exists because
  `summarize.ts` needs it for attached-file summaries; each provider attaches
  it in its own native multimodal format (Anthropic's `document` content
  block, OpenAI's `file` content part with `file_data`).
