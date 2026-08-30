import type { AIProviderId } from './types'
import { PROVIDER_REGISTRY } from './registry'

/**
 * Does this provider have EVERYTHING it needs to be called?
 *
 * Replaces the `!process.env[keyEnvName]?.trim()` check that was written out
 * by hand at eight gate sites (two eager chain resolutions, two legacy-step
 * scans, two in-loop guards, the capacity scan, and the purpose-health
 * "is any text AI usable at all" check). That pattern silently assumed one
 * credential per provider. Cloudflare needs two — its base URL embeds the
 * account id, so a key alone addresses nothing — and an eighth copy of
 * "is it configured" logic is exactly the drift this directory keeps
 * rediscovering.
 *
 * Fails CLOSED: a provider missing any required value is skipped, the same
 * way a provider with no key at all is skipped today. The user sees it as not
 * set up, rather than getting a 404 from a URL with a hole in it.
 *
 * WHY THIS IS ITS OWN MODULE and not a function in registry.ts, which is
 * where it naturally belongs: seventeen test files do a wholesale
 * `vi.mock('../registry')` with their own PROVIDER_REGISTRY. A helper exported
 * from that module is erased by every one of those mocks, and each would have
 * to hand-write a stub — seventeen new copies of the logic, in the tests, all
 * free to drift from the real thing. From here the mock still applies (this
 * module imports './registry' like anything else), so the tests exercise the
 * REAL rule against their own fixture registry, and needed no changes at all.
 */
export function providerHasCredentials(providerId: AIProviderId): boolean {
  const entry = PROVIDER_REGISTRY[providerId]
  if (!entry) return false
  if (!process.env[entry.keyEnvName]?.trim()) return false
  return (entry.requiredEnvNames ?? []).every((n) => Boolean(process.env[n]?.trim()))
}
