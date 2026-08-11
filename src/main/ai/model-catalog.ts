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
    keyUrl: 'https://aistudio.google.com/apikey'
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
    id: 'openrouter-nemotron-3-ultra',
    displayName: 'Nemotron 3 Ultra',
    brand: 'nvidia',
    providerId: 'openrouter',
    lane: 'quality',
    modelId: 'nvidia/nemotron-3-ultra:free',
    contextWindow: 1_000_000,
    retentionPosture: 'unknown',
    retentionUrl: 'https://openrouter.ai/docs/features/privacy-and-logging',
    keyUrl: 'https://openrouter.ai/keys'
    // OpenRouter's own docs confirm training posture varies PER BACKEND
    // PROVIDER it routes to, not a single OpenRouter-wide answer - 'unknown'
    // is the honest answer here, not a placeholder. Not independently
    // re-verified against OpenRouter's live model list (page fetch returned
    // only nav/footer, no model data) - resolveCatalog() confirms live.
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
    keyUrl: 'https://openrouter.ai/keys'
    // Varies by whichever free model OpenRouter routes to at request time -
    // 'unknown' retention and null context window are both correct, not
    // missing data.
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
