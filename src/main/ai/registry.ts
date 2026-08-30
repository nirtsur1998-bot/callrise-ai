// M20: single lookup table replacing ai/index.ts's old hardcoded
// anthropic/openai ternaries. One entry per AIProviderId - adding a 9th
// provider later means adding one entry here (plus the lockstep type list
// in docs/ai-providers.md's "Adding a provider" section), not touching every
// call site that used to branch on providerId directly.
//
// `defaultModel`/`testModel` here are ONLY the M16-parity fallback used when
// a caller never sets req.model (no real call site does, for these six new
// providers - completeWithFallback() always sets req.model from a catalog
// entry) and the "Test key" 1-token round trip. They are NOT the catalog's
// source of truth for which models are offered - see ai/model-catalog.ts.
import type { AIProvider, AIProviderId } from './types'
import { AnthropicProvider } from './providers/anthropic'
import { OpenAIProvider } from './providers/openai'
import { createOpenAICompatibleProvider } from './providers/openai-compatible'
import { createGeminiProvider, DEFAULT_MODEL as GEMINI_DEFAULT_MODEL } from './providers/gemini'

export interface ProviderRegistryEntry {
  displayName: string
  /** Which AiKeyName (ai-keys.ts) backs this provider. */
  keyEnvName: string
  /**
   * BUG-057 — the concrete model a chain step with no explicit `req.model`
   * actually resolves to. Used for exactly one thing: stopping the legacy
   * step and a bundled catalog entry from being the SAME request twice.
   *
   * This matters because six of the eight defaults below are byte-identical
   * to a catalog entry's `modelId` (groq/google/openrouter/nvidia/cerebras/
   * mistral), while resolveChain's dedupe works on `catalogId` — and a legacy
   * step's synthetic `legacy:<provider>` id can never match a real catalog
   * id. For a single-key user, that made attempt 1 and a later "fallback"
   * literally the same call.
   *
   * Undefined for anthropic/openai: they pick per-purpose via MODEL_BY_PURPOSE
   * and have no catalog entries at all, so a collision is impossible there.
   */
  defaultModelId?: string
  /**
   * Env vars BEYOND the API key that must be present before this provider can
   * be called. Empty for all but Cloudflare, whose base URL embeds an account
   * id — a key with no account id addresses nothing, so it must be treated as
   * unconfigured rather than allowed to build a URL with 'undefined' in it.
   *
   * Read through providerHasCredentials() in ./provider-credentials, never
   * directly: the point is that every place which asks "does this provider
   * have what it needs?" asks the same question.
   */
  requiredEnvNames: readonly string[]
  build: (apiKey: string) => AIProvider
}

// Hoisted so `build` and `defaultModelId` read the SAME literal — a second
// copy of these strings that could drift from the first is exactly the kind
// of duplication that makes the dedupe above silently stop working.
const GROQ_CONFIG = {
  id: 'groq',
  displayName: 'Groq',
  baseURL: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
  testModel: 'llama-3.1-8b-instant'
} as const

const OPENROUTER_CONFIG = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  baseURL: 'https://openrouter.ai/api/v1',
  defaultModel: 'openrouter/free'
} as const

const NVIDIA_CONFIG = {
  id: 'nvidia',
  displayName: 'NVIDIA NIM',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  defaultModel: 'deepseek-ai/deepseek-v3.2'
} as const

const CEREBRAS_CONFIG = {
  id: 'cerebras',
  displayName: 'Cerebras',
  baseURL: 'https://api.cerebras.ai/v1',
  defaultModel: 'openai/gpt-oss-120b'
} as const

// ---- M31 additions. Every string below was verified against the provider's
// own current documentation on 2026-08-30, not recalled. Three candidates
// were dropped at that step: GitHub Models (RETIRED 2026-07-30 — every call
// would have 404'd), SambaNova (free tier is 20 requests per DAY) and Alibaba
// Model Studio (base URL is workspace-scoped, so there is no static string).
const ZAI_CONFIG = {
  id: 'zai',
  displayName: 'Z.ai (GLM)',
  baseURL: 'https://api.z.ai/api/paas/v4',
  defaultModel: 'glm-4.7-flash',
  testModel: 'glm-4.5-flash',
  // Z.ai's own Chat Completions reference documents "max_tokens" and never
  // "max_completion_tokens". Identical shape to the Mistral bug below, so it
  // gets the same treatment up front rather than after a deterministic 422.
  maxTokensParam: 'max_tokens'
} as const

const HUGGINGFACE_CONFIG = {
  id: 'huggingface',
  displayName: 'Hugging Face',
  baseURL: 'https://router.huggingface.co/v1',
  defaultModel: 'openai/gpt-oss-120b',
  testModel: 'openai/gpt-oss-20b',
  // This is a ROUTER: it fans out to ~18 downstream inference providers, so
  // the request has to use the field all of them understand rather than the
  // newest OpenAI one. HF's own examples use "max_tokens".
  maxTokensParam: 'max_tokens'
} as const

// Cloudflare's base URL is the only one that is not a constant: it embeds the
// user's own account id. Resolved per build() rather than at module load, so a
// key saved in Settings takes effect on the very next call with no restart —
// the same promise every other provider here makes.
//
// Verified against Cloudflare's own docs 2026-08-30: the base URL shape and
// both model ids came off their OpenAI-compatibility page and the individual
// model pages. Their compat page documents /chat/completions and /embeddings
// and does NOT document streaming, tool calling, or which max-tokens field it
// accepts — see the notes on ZAI_CONFIG below for why that field is pinned.
const CLOUDFLARE_ACCOUNT_ENV = 'CLOUDFLARE_ACCOUNT_ID'

const CLOUDFLARE_CONFIG = {
  id: 'cloudflare',
  displayName: 'Cloudflare Workers AI',
  defaultModel: '@cf/openai/gpt-oss-120b',
  testModel: '@cf/meta/llama-3.1-8b-instruct-fast',
  // Undocumented on their compat page; 'max_tokens' is what Cloudflare's own
  // native inference API takes, and it is the field every OpenAI-compatible
  // gateway accepts. Same defensive choice as Mistral's, for the same reason.
  maxTokensParam: 'max_tokens'
} as const

function cloudflareConfig(): typeof CLOUDFLARE_CONFIG & { baseURL: string } {
  const accountId = process.env[CLOUDFLARE_ACCOUNT_ENV]?.trim()
  return {
    ...CLOUDFLARE_CONFIG,
    // Unreachable while providerHasCredentials() gates every call path. If it
    // ever IS reached, this sentinel makes the cause legible in a log instead
    // of sending the string 'undefined' inside an otherwise valid-looking URL.
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId ?? 'MISSING-ACCOUNT-ID'}/ai/v1`
  }
}

const MISTRAL_CONFIG = {
  id: 'mistral',
  displayName: 'Mistral',
  baseURL: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-small-latest',
  // Mistral's Chat Completions endpoint only accepts `max_tokens` —
  // sending the (OpenAI-current) `max_completion_tokens` 422s the
  // whole request. See OpenAICompatibleConfig.maxTokensParam.
  maxTokensParam: 'max_tokens'
} as const

export const PROVIDER_REGISTRY: Record<AIProviderId, ProviderRegistryEntry> = {
  anthropic: {
    displayName: 'Claude',
    keyEnvName: 'ANTHROPIC_API_KEY',
    requiredEnvNames: [],
    build: (key) => new AnthropicProvider(key)
  },
  openai: {
    displayName: 'ChatGPT',
    keyEnvName: 'OPENAI_API_KEY',
    requiredEnvNames: [],
    build: (key) => new OpenAIProvider(key)
  },
  groq: {
    displayName: 'Groq',
    keyEnvName: 'GROQ_API_KEY',
    requiredEnvNames: [],
    defaultModelId: GROQ_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(GROQ_CONFIG, key)
  },
  openrouter: {
    displayName: 'OpenRouter',
    keyEnvName: 'OPENROUTER_API_KEY',
    requiredEnvNames: [],
    defaultModelId: OPENROUTER_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(OPENROUTER_CONFIG, key)
  },
  google: {
    displayName: 'Gemini',
    keyEnvName: 'GOOGLE_AI_API_KEY',
    requiredEnvNames: [],
    defaultModelId: GEMINI_DEFAULT_MODEL,
    build: (key) => createGeminiProvider(key)
  },
  nvidia: {
    displayName: 'NVIDIA NIM',
    keyEnvName: 'NVIDIA_API_KEY',
    requiredEnvNames: [],
    defaultModelId: NVIDIA_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(NVIDIA_CONFIG, key)
  },
  cerebras: {
    displayName: 'Cerebras',
    keyEnvName: 'CEREBRAS_API_KEY',
    requiredEnvNames: [],
    defaultModelId: CEREBRAS_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(CEREBRAS_CONFIG, key)
  },
  mistral: {
    displayName: 'Mistral',
    keyEnvName: 'MISTRAL_API_KEY',
    requiredEnvNames: [],
    defaultModelId: MISTRAL_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(MISTRAL_CONFIG, key)
  },
  zai: {
    displayName: 'Z.ai (GLM)',
    keyEnvName: 'ZAI_API_KEY',
    requiredEnvNames: [],
    defaultModelId: ZAI_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(ZAI_CONFIG, key)
  },
  huggingface: {
    displayName: 'Hugging Face',
    keyEnvName: 'HUGGINGFACE_API_KEY',
    requiredEnvNames: [],
    defaultModelId: HUGGINGFACE_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(HUGGINGFACE_CONFIG, key)
  },
  cloudflare: {
    displayName: 'Cloudflare Workers AI',
    keyEnvName: 'CLOUDFLARE_API_KEY',
    requiredEnvNames: [CLOUDFLARE_ACCOUNT_ENV],
    defaultModelId: CLOUDFLARE_CONFIG.defaultModel,
    build: (key) => createOpenAICompatibleProvider(cloudflareConfig(), key)
  }
}
