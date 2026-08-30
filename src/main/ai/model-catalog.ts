// M20 model catalog. This is a BUNDLED FALLBACK, not the source of truth —
// live availability comes from each provider's /models endpoint via
// resolveCatalog() below. Free-tier rosters churn fast (OpenRouter delisted
// its entire free Llama/Qwen tier inside nine days in July 2026, per the
// milestone brief) — never treat this array as guaranteed-current.
//
// Verified 2026-07-30 against each provider's live public docs where
// reachable (see per-entry `knownStale` comments for what did and didn't
// check out — two entries below are already flagged unavailable rather than
// silently swapped for a different model, per the brief's explicit
// instruction). Entries I could not independently verify (no live key
// available to hit an authenticated /models endpoint) are marked as such;
// resolveCatalog() is the real confirmation once a user's real key runs it.
import type { AIProviderId } from './types'
import { PROVIDER_REGISTRY } from './registry'

// The 8 model brands from the brief, plus 'openrouter' for the one entry
// (auto-router) whose "model" is OpenRouter's own routing feature rather
// than a named model with its own brand mark - reuses the OpenRouter
// provider-badge asset as its model logo too, which is accurate (that IS
// what's picking the model), not a workaround.
export type ModelBrand =
  | 'meta'
  | 'openai'
  | 'qwen'
  | 'google'
  | 'deepseek'
  | 'nvidia'
  | 'zai'
  | 'mistral'
  | 'openrouter'

export type ModelLane = 'speed' | 'quality'

export type RetentionPosture = 'trains' | 'no-training' | 'unknown'

export interface CatalogEntry {
  /** Stable id used everywhere else (settings chains, fallback-event log,
   *  UI selection) — NOT the same as modelId, which is what's sent to the
   *  provider. Two entries can share a modelId+displayName on different
   *  providers (the dual-homed GPT-OSS 120B). */
  id: string
  displayName: string
  brand: ModelBrand
  providerId: AIProviderId
  lane: ModelLane
  /** The literal string sent as AICompletionRequest.model. */
  modelId: string
  /** null = "varies by routed model" (the OpenRouter auto-router entry only). */
  contextWindow: number | null
  retentionPosture: RetentionPosture
  /** Where a user can read the actual terms — always shown next to the badge. */
  retentionUrl: string
  keyUrl: string
  /** Set only when I found direct evidence (2026-07-30, see comments below)
   *  that this modelId no longer resolves on the provider's current model
   *  list. Per the brief: never silently substitute a different model for a
   *  404'd one — surface it as unavailable instead. resolveCatalog() below
   *  re-checks this live once a real key is configured, which can clear
   *  (or confirm) this flag. */
  knownStale?: string
  /** BUG-057 Phase 6 — hand-verified against provider docs, same convention
   *  as knownStale, but UNLIKE knownStale (whose staleness resolveCatalog()
   *  re-checks live every ~10 min) there is no live signal to build a real
   *  check from: listModels() returns ID strings only, no capability data.
   *  `false` = verified NOT to support forced tool calls, dated in the
   *  entry's own comment where set. Undefined = "assumed to support it,
   *  unverified" — a newly added entry without this field is never silently
   *  excluded. STALENESS RISK, now made VISIBLE (BUG-057 Phase 6 follow-up):
   *  there's still no automatic re-check (listModels() has no capability
   *  data to build one from), so a `false` entry that's gone stale — the
   *  provider shipped tool-calling support later — stays excluded from a
   *  needsTool chain until someone manually revisits it. But the exclusion
   *  is no longer SILENT: complete-with-fallback.ts's
   *  logToolCapabilityExclusions() records it (once per model per session)
   *  to fallback-log.ts, so it surfaces in Settings → Model Assignment's
   *  recent-activity list, diagnosable there the same as any other fallback
   *  decision. Still treat a `false` entry as needing the same periodic-audit
   *  attention as a `knownStale` one — the log makes a stale flag findable,
   *  it doesn't self-heal it. */
  supportsToolCalling?: false
  /** M28 Part 3 — hand-verified image-input support, dated in the entry's
   *  comment where set. POSITIVE flag (unlike supportsToolCalling): undefined
   *  = "not known to see", so a new entry is never silently sent an image it
   *  can't read. Providers without catalog entries (Claude, ChatGPT) are
   *  handled by complete-with-fallback.ts's legacy-step vision set. */
  supportsVision?: true
  /** AUDIT FIX (2026-08-24) — hand-verified PDF/document input support. Same
   *  POSITIVE-flag discipline as supportsVision: undefined = "not known to
   *  read documents", so a new entry is never silently sent a PDF it cannot
   *  parse.
   *
   *  This flag did not exist, and its absence was the second half of a
   *  field-critical bug. `needsVision` was derived from req.images ONLY, so a
   *  PDF passed through resolveChain unfiltered and openai-compatible.ts:99
   *  emitted an OpenAI-only `{type:'file'}` part to Groq / NVIDIA / Mistral /
   *  OpenRouter / Cerebras — none of which accept it. Every resulting 400 was
   *  classified 'structural' and blacklisted that model.
   *
   *  Verified per adapter, 2026-08-24: anthropic.ts:146 builds a native
   *  `type:'document'` block, gemini.ts:108 builds `inlineData` with
   *  application/pdf, and openai.ts:112 uses OpenAI's own file part — all
   *  three genuinely carry a PDF. openai-compatible.ts is the odd one out: it
   *  reuses OpenAI's wire format against providers that never adopted it. */
  supportsDocuments?: true
}

export const MODEL_CATALOG: CatalogEntry[] = [
  // ---- Speed lane — live in-call coaching cues ----
  {
    id: 'groq-llama-3.1-8b-instant',
    displayName: 'Llama 3.1 8B Instant',
    brand: 'meta',
    providerId: 'groq',
    lane: 'speed',
    modelId: 'llama-3.1-8b-instant',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://groq.com/privacy-policy/',
    keyUrl: 'https://console.groq.com/keys'
    // Verified present on Groq's live model list (console.groq.com/docs/models), 2026-07-30.
  },
  {
    id: 'groq-llama-3.3-70b-versatile',
    displayName: 'Llama 3.3 70B Versatile',
    brand: 'meta',
    providerId: 'groq',
    lane: 'speed',
    modelId: 'llama-3.3-70b-versatile',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://groq.com/privacy-policy/',
    keyUrl: 'https://console.groq.com/keys'
    // Verified present on Groq's live model list, 2026-07-30.
  },
  {
    id: 'groq-gpt-oss-120b',
    displayName: 'GPT-OSS 120B',
    brand: 'openai',
    providerId: 'groq',
    lane: 'speed',
    modelId: 'openai/gpt-oss-120b',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://groq.com/privacy-policy/',
    keyUrl: 'https://console.groq.com/keys'
    // Dual-homed with cerebras-gpt-oss-120b below (Groq primary, Cerebras
    // fallback per the brief) — modeled as two catalog entries so the
    // general fallback-chain mechanism handles the failover, not a special
    // case. Verified present on Groq's live model list, 2026-07-30.
  },
  {
    id: 'cerebras-gpt-oss-120b',
    displayName: 'GPT-OSS 120B',
    brand: 'openai',
    providerId: 'cerebras',
    lane: 'speed',
    modelId: 'openai/gpt-oss-120b',
    contextWindow: 128_000,
    retentionPosture: 'no-training',
    retentionUrl: 'https://www.cerebras.ai/terms-of-service',
    keyUrl: 'https://cloud.cerebras.ai/'
    // Cerebras fallback for the entry above. Retention confirmed 2026-07-30
    // via Cerebras's live Terms of Service: "the foregoing does not grant
    // Cerebras the right to use Service Content for the purpose of training
    // or fine-tuning models" — applies to both free and paid tiers per that
    // page. Model ID not independently re-verified against Cerebras's own
    // model list (no live key) - resolveCatalog() confirms once configured.
  },
  {
    id: 'groq-llama-4-scout',
    displayName: 'Llama 4 Scout',
    brand: 'meta',
    providerId: 'groq',
    lane: 'speed',
    modelId: 'meta-llama/llama-4-scout-17b-16e-instruct',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://groq.com/privacy-policy/',
    keyUrl: 'https://console.groq.com/keys',
    // M28 Part 3 — Llama 4 Scout is natively multimodal (image input) per
    // Meta's model card and Groq's vision docs, 2026-08-21.
    supportsVision: true,
    knownStale:
      'Not found on Groq\'s live model list (console.groq.com/docs/models) as of 2026-07-30 - ' +
      'flagged unavailable rather than silently substituted. resolveCatalog() re-checks on next key config.'
  },
  {
    id: 'groq-qwen3-32b',
    displayName: 'Qwen3 32B',
    brand: 'qwen',
    providerId: 'groq',
    lane: 'speed',
    modelId: 'qwen/qwen3-32b',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://groq.com/privacy-policy/',
    keyUrl: 'https://console.groq.com/keys',
    knownStale:
      'Not found on Groq\'s live model list as of 2026-07-30 - the list instead shows ' +
      '"qwen/qwen3.6-27b", a different id. Per the brief, not silently substituted - flagged ' +
      'unavailable. resolveCatalog() re-checks on next key config.'
  },

  // ---- Quality lane — post-call summaries, scorecards, prep briefs ----
  {
    id: 'google-gemini-flash',
    displayName: 'Gemini Flash',
    brand: 'google',
    providerId: 'google',
    lane: 'quality',
    // A stable Google-maintained alias, not a hardcoded dated snapshot -
    // always resolves to whatever Google currently calls "Flash". The
    // GeminiProvider's listModels() (gemini.ts) is still the live source of
    // truth resolveCatalog() checks against.
    modelId: 'gemini-flash-latest',
    contextWindow: 1_000_000,
    retentionPosture: 'trains',
    retentionUrl: 'https://ai.google.dev/gemini-api/terms',
    keyUrl: 'https://aistudio.google.com/apikey',
    // M28 Part 3 — every Gemini Flash generation accepts image input.
    supportsVision: true,
    // AUDIT FIX (2026-08-24) — gemini.ts:108 sends PDFs as inlineData with
    // mimeType application/pdf, which the Gemini API accepts natively. The
    // only catalog entry that can read a document: every other entry routes
    // through openai-compatible.ts, whose file part these providers reject.
    supportsDocuments: true
    // Retention CONFIRMED 2026-07-30 via Google's live Gemini API terms:
    // free/unpaid tier - "Google uses the content you submit to the
    // Services and any generated responses to provide, improve, and develop
    // Google products and services" (explicitly differs from the paid tier,
    // which is not used for training). This is the one catalog entry with a
    // real, user-facing "Trains on your data" warning - surface it clearly.
  },
  {
    id: 'nvidia-deepseek-v3.2',
    displayName: 'DeepSeek V3.2',
    brand: 'deepseek',
    providerId: 'nvidia',
    lane: 'quality',
    modelId: 'deepseek-ai/deepseek-v3.2',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://build.nvidia.com/terms',
    keyUrl: 'https://build.nvidia.com/'
    // Not independently re-verified against NVIDIA's live model catalog (no
    // live key, and build.nvidia.com/models was unreachable during
    // implementation). resolveCatalog() confirms once a real key is entered.
  },
  {
    id: 'openrouter-nemotron-3.5-lightning',
    displayName: 'Nemotron 3.5 Lightning',
    brand: 'nvidia',
    providerId: 'openrouter',
    lane: 'quality',
    modelId: 'nvidia/nemotron-3.5-lightning:free',
    contextWindow: 1_000_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://openrouter.ai/docs/features/privacy-and-logging',
    keyUrl: 'https://openrouter.ai/keys'
    // M27 B2 — REPLACES the prior 'openrouter-nemotron-3-ultra' entry, whose
    // modelId 'nvidia/nemotron-3-ultra:free' returned a 400 on 100% of the 23
    // times it was tried in this app's own fallback log. Verified 2026-08-14
    // against OpenRouter's live /api/v1/models: 'nvidia/nemotron-3-ultra:free'
    // no longer exists at all (which is exactly the 400), and the current
    // Nemotron on OpenRouter's free tier is 'nvidia/nemotron-3.5-lightning:free'
    // — confirmed present, with tools/tool_choice in its supported_parameters
    // and a 1M context window. Retention stays 'unknown', same as the entry it
    // replaces and for the same reason: OpenRouter's training posture varies
    // per backend provider it routes to, not one OpenRouter-wide answer.
    // A specific free-tier id is inherently churn-prone (the catalog header
    // notes OpenRouter delisted its whole free Llama/Qwen tier in nine days) —
    // resolveCatalog() re-checks this id live once a real key is configured,
    // and knownStale is the mechanism if it goes dead the way its predecessor
    // did.
  },
  {
    id: 'nvidia-glm-5.2',
    displayName: 'GLM-5.2',
    brand: 'zai',
    providerId: 'nvidia',
    lane: 'quality',
    modelId: 'zai/glm-5.2',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://build.nvidia.com/terms',
    keyUrl: 'https://build.nvidia.com/'
    // Not independently re-verified (same caveat as DeepSeek V3.2 above).
  },
  {
    id: 'mistral-small',
    displayName: 'Mistral Small',
    brand: 'mistral',
    providerId: 'mistral',
    lane: 'quality',
    modelId: 'mistral-small-latest',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://legal.mistral.ai/terms',
    keyUrl: 'https://console.mistral.ai/api-keys'
    // Mistral's terms landing page didn't surface explicit API training
    // language during implementation (only a links page reachable) -
    // 'unknown' rather than assuming their commonly-cited "we don't train on
    // your data" marketing claim without a direct primary-source quote.
  },

  // ---- M31: Z.ai (GLM). Both ids are listed at $0.00 in/out on Z.ai's own
  // pricing page, indefinitely — an ongoing free tier, not expiring credits.
  // Ids taken from their API reference, which enumerates them lowercase;
  // their marketing pages render the same models "GLM-4.5-Flash". Verified
  // 2026-08-30. NOTE: Z.ai has no free LARGE model — the quality entry below
  // is their best FREE model, not their best model.
  {
    id: 'zai-glm-4.5-flash',
    displayName: 'GLM-4.5 Flash',
    brand: 'zai',
    providerId: 'zai',
    lane: 'speed',
    modelId: 'glm-4.5-flash',
    contextWindow: 128_000,
    retentionPosture: 'no-training',
    retentionUrl: 'https://docs.z.ai/legal-agreement/terms-of-use',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list'
    // 'no-training' rests on a direct quote from their Terms of Use, and is
    // scoped to API users: Z.ai will not use End User Content to develop or
    // improve its services without explicit agreement. Their consumer chat
    // platform gets weaker terms — this entry is the API only.
  },
  {
    id: 'zai-glm-4.7-flash',
    displayName: 'GLM-4.7 Flash',
    brand: 'zai',
    providerId: 'zai',
    lane: 'quality',
    modelId: 'glm-4.7-flash',
    contextWindow: 128_000,
    retentionPosture: 'no-training',
    retentionUrl: 'https://docs.z.ai/legal-agreement/terms-of-use',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list'
    // Same terms as the entry above. Z.ai publishes no numeric rate limit in
    // its own docs; secondary sources say one concurrent request on the free
    // tier, which I could not confirm officially and so have not encoded.
  },

  // ---- M31: Hugging Face Inference Providers (a ROUTER, like OpenRouter).
  // Both ids were confirmed against the LIVE endpoint — GET
  // router.huggingface.co/v1/models, 2026-08-30 — not a docs page, which is
  // the strongest verification any entry in this file has.
  {
    id: 'hf-gpt-oss-20b',
    displayName: 'GPT-OSS 20B',
    brand: 'openai',
    providerId: 'huggingface',
    lane: 'speed',
    modelId: 'openai/gpt-oss-20b',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://huggingface.co/docs/inference-providers/security',
    keyUrl: 'https://huggingface.co/settings/tokens'
    // 'unknown' is deliberate and is NOT a gap in the research. Hugging Face
    // itself is clean — it states it does not store the request body or
    // response, and keeps debug logs 30 days — but the inference happens at
    // whichever of ~18 downstream providers the router picks, and HF's own
    // security page refers you to each provider's terms. The honest posture
    // for a routed request is therefore 'unknown', exactly as it is for the
    // OpenRouter auto-router entry below.
  },
  {
    id: 'hf-gpt-oss-120b',
    displayName: 'GPT-OSS 120B',
    brand: 'openai',
    providerId: 'huggingface',
    lane: 'quality',
    modelId: 'openai/gpt-oss-120b',
    contextWindow: 128_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://huggingface.co/docs/inference-providers/security',
    keyUrl: 'https://huggingface.co/settings/tokens'
    // THIRD home for this model (Groq and Cerebras above), which the chain
    // mechanism handles as ordinary fallback. Lane differs from those two on
    // purpose: they are speed-lane because Groq and Cerebras are unusually
    // fast inference, whereas the HF router is not — same weights, different
    // latency characteristics, so the lane that reflects reality is quality.
    // Same routed-retention caveat as the entry above.
  },

  // ---- Auto-router — resilience when a specific free id gets pulled ----
  {
    id: 'openrouter-auto-free',
    displayName: 'Auto (OpenRouter picks)',
    brand: 'openrouter',
    providerId: 'openrouter',
    lane: 'quality',
    modelId: 'openrouter/free',
    contextWindow: null,
    retentionPosture: 'unknown',
    retentionUrl: 'https://openrouter.ai/docs/features/privacy-and-logging',
    keyUrl: 'https://openrouter.ai/keys',
    // Varies by whichever free model OpenRouter routes to at request time -
    // 'unknown' retention and null context window are both correct, not
    // missing data.
    //
    // M27 B2 — supportsToolCalling:false. This app's own fallback log
    // recorded 39 attempts of this entry, every one a failure; 28 of them
    // (24 "did not return the expected structured output" + 4 "malformed
    // structured output") were tool-call parse failures from parseToolInput
    // (openai-compatible.ts) — the free models the auto-router lands on
    // frequently can't produce a valid forced function call. It sat as the
    // last-resort quality-chain entry for tool-using purposes, so on those it
    // burned a request and the wait to fail before the chain exhausted —
    // worse than having no last resort at all (the founder's own framing).
    // This flag removes it from needsTool chains ONLY (resolveChain's
    // capability filter); it stays a genuine last resort for plain-text
    // purposes (coaching-chat streaming, a tool-less summary/prep-brief),
    // where the router's output is usable. Unlike a per-MODEL flag this is a
    // per-ROUTER judgment — auto sometimes lands on a tool-capable model —
    // but 28/39 real failures is a clear enough signal not to TRY it for
    // tools, and logToolCapabilityExclusions() records the exclusion so a
    // future improvement in OpenRouter's free routing surfaces as a stale
    // flag rather than staying invisible.
    supportsToolCalling: false
  }
]

export function catalogEntry(id: string): CatalogEntry | undefined {
  return MODEL_CATALOG.find((e) => e.id === id)
}

export function catalogEntriesForProvider(providerId: AIProviderId): CatalogEntry[] {
  return MODEL_CATALOG.filter((e) => e.providerId === providerId)
}

export interface ResolvedCatalogEntry extends CatalogEntry {
  /** True when this provider has a key configured right now - an entry
   *  with hasKey:false can still be shown in the picker (so the user can see
   *  what pasting a key would unlock) but never enters a resolved fallback
   *  chain (see complete-with-fallback.ts). */
  hasKey: boolean
  /** Best-effort live confirmation against the provider's own /models list.
   *  Never independently punishes a transient /models failure - see
   *  per-branch comments below. A `knownStale` entry starts `false` and can
   *  only flip `true` if a live check explicitly finds the id again. */
  available: boolean
}

let cachedAt = 0
let cache: ResolvedCatalogEntry[] | null = null
const CACHE_TTL_MS = 10 * 60 * 1000

/** Cross-checks the bundled catalog against each configured provider's live
 *  /models endpoint - the actual "no model ID hardcoded as sole source of
 *  truth" mechanism. Cached in-memory per app session (manual refresh via
 *  `forceRefresh`); never re-fetches for a provider with no key configured
 *  (nothing to check, and no reason to make an unauthenticated call). */
export async function resolveCatalog(opts?: { forceRefresh?: boolean }): Promise<ResolvedCatalogEntry[]> {
  if (!opts?.forceRefresh && cache && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cache
  }

  const listModelsByProvider = new Map<AIProviderId, Promise<string[] | null>>()
  const providerHasKey = new Map<AIProviderId, boolean>()

  for (const providerId of new Set(MODEL_CATALOG.map((e) => e.providerId))) {
    const entry = PROVIDER_REGISTRY[providerId]
    const key = process.env[entry.keyEnvName]?.trim()
    providerHasKey.set(providerId, Boolean(key))
    if (!key) continue
    listModelsByProvider.set(
      providerId,
      entry
        .build(key)
        .listModels()
        .catch(() => null) // unreachable/unsupported - resolved below as "can't confirm"
    )
  }

  const resolved: ResolvedCatalogEntry[] = []
  for (const item of MODEL_CATALOG) {
    const hasKey = providerHasKey.get(item.providerId) ?? false
    if (!hasKey) {
      resolved.push({ ...item, hasKey: false, available: !item.knownStale })
      continue
    }
    const liveModels = await listModelsByProvider.get(item.providerId)
    if (liveModels === null || liveModels === undefined) {
      // /models unreachable or the provider doesn't support listing -
      // don't punish a transient hiccup, but a previously-flagged-stale
      // entry stays flagged until a live check actually clears it.
      resolved.push({ ...item, hasKey: true, available: !item.knownStale })
      continue
    }
    resolved.push({ ...item, hasKey: true, available: liveModels.includes(item.modelId) })
  }

  cache = resolved
  cachedAt = Date.now()
  return resolved
}
