import type { AIProvider, AIProviderId } from './types'
import { AnthropicProvider } from './providers/anthropic'
import { OpenAIProvider } from './providers/openai'
import { loadAppSettings } from '../app-settings'

export * from './types'

const KEY_ENV_BY_PROVIDER: Record<AIProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY'
}

/** Which key env var backs a given provider — ai-keys.ts's loadStoredAiKeysIntoEnv()
 *  populates these at startup from encrypted storage. */
export function keyEnvNameFor(providerId: AIProviderId): string {
  return KEY_ENV_BY_PROVIDER[providerId]
}

/** Build the active provider for one call, or null if its key isn't configured.
 *  Never cached across calls - a key entered/cleared mid-session (or a
 *  provider switch in Settings) must take effect on the very next call,
 *  not after a restart. Constructing an SDK client is cheap. */
export function getAIProvider(providerId: AIProviderId): AIProvider | null {
  const key = process.env[KEY_ENV_BY_PROVIDER[providerId]]?.trim()
  if (!key) return null
  return providerId === 'anthropic' ? new AnthropicProvider(key) : new OpenAIProvider(key)
}

/** The single entry point every call site uses - reads the user's chosen
 *  provider from Settings and builds it if its key is configured. Returns
 *  null if unconfigured (no key, or the chosen provider's key was never
 *  set) - every call site already treats a null client as "AI features show
 *  an empty state, transcription still works fully" so this preserves that
 *  behavior unchanged for whichever provider is active. */
export function getActiveAIProvider(): AIProvider | null {
  return getAIProvider(loadAppSettings().aiProvider)
}

/** Build a specific, ad-hoc provider from a raw key - used only by the
 *  Settings "Test key" flow, which validates a key the user just pasted and
 *  hasn't necessarily saved yet. */
export function buildProviderForValidation(providerId: AIProviderId, apiKey: string): AIProvider {
  return providerId === 'anthropic' ? new AnthropicProvider(apiKey) : new OpenAIProvider(apiKey)
}
