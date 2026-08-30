import type { AIProvider, AIProviderId } from './types'
import { PROVIDER_REGISTRY } from './registry'
import { providerHasCredentials } from './provider-credentials'
import { loadAppSettings } from '../app-settings'

export * from './types'
export { PROVIDER_REGISTRY } from './registry'
export type { ProviderRegistryEntry } from './registry'

/** Which key env var backs a given provider — ai-keys.ts's loadStoredAiKeysIntoEnv()
 *  populates these at startup from encrypted storage. */
export function keyEnvNameFor(providerId: AIProviderId): string {
  return PROVIDER_REGISTRY[providerId].keyEnvName
}

/** Build the active provider for one call, or null if its key isn't configured.
 *  Never cached across calls - a key entered/cleared mid-session (or a
 *  provider switch in Settings) must take effect on the very next call,
 *  not after a restart. Constructing an SDK client is cheap. */
export function getAIProvider(providerId: AIProviderId): AIProvider | null {
  const entry = PROVIDER_REGISTRY[providerId]
  const key = process.env[entry.keyEnvName]?.trim()
  // providerHasCredentials, not just the key: Cloudflare also needs an account
  // id, and a provider built without one would address nothing.
  if (!key || !providerHasCredentials(providerId)) return null
  return entry.build(key)
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
  return PROVIDER_REGISTRY[providerId].build(apiKey)
}
