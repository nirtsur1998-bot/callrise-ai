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
import { createGeminiProvider } from './providers/gemini'

export interface ProviderRegistryEntry {
  displayName: string
  /** Which AiKeyName (ai-keys.ts) backs this provider. */
  keyEnvName: string
  build: (apiKey: string) => AIProvider
}

export const PROVIDER_REGISTRY: Record<AIProviderId, ProviderRegistryEntry> = {
  anthropic: {
    displayName: 'Claude',
    keyEnvName: 'ANTHROPIC_API_KEY',
    build: (key) => new AnthropicProvider(key)
  },
  openai: {
    displayName: 'ChatGPT',
    keyEnvName: 'OPENAI_API_KEY',
    build: (key) => new OpenAIProvider(key)
  },
  groq: {
    displayName: 'Groq',
    keyEnvName: 'GROQ_API_KEY',
    build: (key) =>
      createOpenAICompatibleProvider(
        {
          id: 'groq',
          displayName: 'Groq',
          baseURL: 'https://api.groq.com/openai/v1',
          defaultModel: 'llama-3.3-70b-versatile',
          testModel: 'llama-3.1-8b-instant'
        },
        key
      )
  },
  openrouter: {
    displayName: 'OpenRouter',
    keyEnvName: 'OPENROUTER_API_KEY',
    build: (key) =>
      createOpenAICompatibleProvider(
        {
          id: 'openrouter',
          displayName: 'OpenRouter',
          baseURL: 'https://openrouter.ai/api/v1',
          defaultModel: 'openrouter/free'
        },
        key
      )
  },
  google: {
    displayName: 'Gemini',
    keyEnvName: 'GOOGLE_AI_API_KEY',
    build: (key) => createGeminiProvider(key)
  },
  nvidia: {
    displayName: 'NVIDIA NIM',
    keyEnvName: 'NVIDIA_API_KEY',
    build: (key) =>
      createOpenAICompatibleProvider(
        {
          id: 'nvidia',
          displayName: 'NVIDIA NIM',
          baseURL: 'https://integrate.api.nvidia.com/v1',
          defaultModel: 'deepseek-ai/deepseek-v3.2'
        },
        key
      )
  },
  cerebras: {
    displayName: 'Cerebras',
    keyEnvName: 'CEREBRAS_API_KEY',
    build: (key) =>
      createOpenAICompatibleProvider(
        {
          id: 'cerebras',
          displayName: 'Cerebras',
          baseURL: 'https://api.cerebras.ai/v1',
          defaultModel: 'openai/gpt-oss-120b'
        },
        key
      )
  },
  mistral: {
    displayName: 'Mistral',
    keyEnvName: 'MISTRAL_API_KEY',
    build: (key) =>
      createOpenAICompatibleProvider(
        {
          id: 'mistral',
          displayName: 'Mistral',
          baseURL: 'https://api.mistral.ai/v1',
          defaultModel: 'mistral-small-latest',
          // Mistral's Chat Completions endpoint only accepts `max_tokens` —
          // sending the (OpenAI-current) `max_completion_tokens` 422s the
          // whole request. See OpenAICompatibleConfig.maxTokensParam.
          maxTokensParam: 'max_tokens'
        },
        key
      )
  }
}
