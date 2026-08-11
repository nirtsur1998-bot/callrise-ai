// M20: the fallback-chain orchestrator. Every call site that wants per-job
// model assignment + resilience calls completeWithFallback(purpose, req)
// instead of getActiveAIProvider()?.complete(req) directly.
//
// Resolution rule (deliberately NOT "empty chain -> default catalog chain" -
// see docs/ai-providers.md's M20 addendum for the full reasoning): a
// configured chain wins; failing that, today's getActiveAIProvider()
// behavior wins (so an existing M16 install with a configured provider+key
// sees zero change); only when NEITHER exists does the bundled
// DEFAULT_CATALOG_CHAIN kick in (fresh installs, or a purpose nobody has
// configured anything for).
import { PROVIDER_REGISTRY } from './registry'
import { getActiveAIProvider } from './index'
import { loadAppSettings } from '../app-settings'
import { catalogEntry, type CatalogEntry } from './model-catalog'
import { logFallbackEvent } from './fallback-log'
import {
  AIProviderError,
  CHAIN_BUDGET,
  LATENCY_POLICY,
  type AICompletionRequest,
  type AICompletionResult,
  type AIPurpose
} from './types'

export class AllModelsExhaustedError extends Error {
  constructor(
    readonly purpose: AIPurpose,
    readonly attempts: { catalogId: string; reason: string }[]
  ) {
    super(
      `Every configured model for "${purpose}" failed: ${attempts.map((a) => a.reason).join('; ')}`
    )
    this.name = 'AllModelsExhaustedError'
  }
}

const SPEED_CHAIN = [
  'groq-llama-3.1-8b-instant',
  'groq-llama-3.3-70b-versatile',
  'groq-gpt-oss-120b',
  'cerebras-gpt-oss-120b',
  'groq-llama-4-scout',
  'groq-qwen3-32b'
]

// Quality-lane preference first, but with the Groq/Cerebras speed entries
// appended as a safety net - this is what makes "paste only a Groq key and
// every job still works end-to-end" true for the non-speed jobs too, since
// only entries whose provider has a configured key are ever attempted (see
// resolveChain below) - an unconfigured entry earlier in this list costs
// nothing, it's just skipped.
const QUALITY_CHAIN = [
  'google-gemini-flash',
  'nvidia-deepseek-v3.2',
  'openrouter-nemotron-3-ultra',
  'nvidia-glm-5.2',
  'mistral-small',
  'openrouter-auto-free',
  'groq-llama-3.3-70b-versatile',
  'groq-gpt-oss-120b',
  'cerebras-gpt-oss-120b'
]

const coachingCap = CHAIN_BUDGET['coaching-cue']?.maxChainLength ?? 2
const dealTier1Cap = CHAIN_BUDGET['deal-tier1']?.maxChainLength ?? 2

/** Bundled fallback ordering, only reached when a purpose has neither an
 *  explicit chain configured nor a legacy `aiProvider`+key. Not lane-
 *  restricted for the same reason QUALITY_CHAIN isn't - see above. */
export const DEFAULT_CATALOG_CHAIN: Record<AIPurpose, string[]> = {
  'coaching-cue': SPEED_CHAIN.slice(0, coachingCap),
  summary: QUALITY_CHAIN,
  scorecard: QUALITY_CHAIN,
  tasks: QUALITY_CHAIN,
  // No Settings UI ever populates 'other' (4 call sites: objection-mining,
  // call-title, crm-notes, deal-risk) - it stays on getActiveAIProvider()
  // forever via the legacy-path branch below, never reaching this array.
  other: [],
  'prep-brief': QUALITY_CHAIN,
  // M24 - same speed-lane precedent as coaching-cue (see CHAIN_BUDGET's doc
  // comment in types.ts): a live, latency-critical path gets the fast chain,
  // capped the same way.
  'deal-tier1': SPEED_CHAIN.slice(0, dealTier1Cap),
  // M24 - quality-lane precedent, same as summary/scorecard/prep-brief; no
  // cap, since deal-tier2 has no CHAIN_BUDGET entry.
  'deal-tier2': QUALITY_CHAIN
}

interface ResolvedStep {
  catalogId: string
  providerId: CatalogEntry['providerId']
  modelId: string
}

function legacyStep(): ResolvedStep | null {
  const provider = getActiveAIProvider()
  if (!provider) return null
  // No catalog entry backs this step (it's whatever MODEL_BY_PURPOSE the
  // active provider itself would pick) - synthesize a stable pseudo-id for
  // logging only, req.model stays unset so the provider uses its own
  // internal default, exactly like every M16-era call site today.
  return { catalogId: `legacy:${provider.id}`, providerId: provider.id, modelId: '' }
}

// Exported for direct unit testing (mocking loadAppSettings + process.env is
// simpler and faster than driving the whole completeWithFallback path).
export function resolveChain(purpose: AIPurpose): ResolvedStep[] {
  const configured = loadAppSettings().aiModelAssignments[purpose].chain
  const candidateIds = configured.length > 0 ? configured : null

  if (candidateIds) {
    const steps: ResolvedStep[] = []
    for (const id of candidateIds) {
      const entry = catalogEntry(id)
      if (!entry) continue
      // A model the catalog itself already knows is dead (delisted/404,
      // see model-catalog.ts's per-entry `knownStale` comments) will fail
      // every single time it's tried — skip it here the same way a missing
      // key is skipped, rather than spending one of a possibly short chain's
      // few slots (coaching-cue is capped at 2, specifically "so a miss never
      // means dead air") on a guaranteed failure. Settings still lets a user
      // pick it — the picker shows the same red "Unavailable" signal this
      // reads — but the runtime should never attempt it blind. This only
      // catches statically-known-dead entries; a model that goes stale
      // WITHOUT `knownStale` being set is a separate, live-check gap
      // (resolveCatalog's async availability check isn't wired into this
      // synchronous hot path) — not fixed here.
      if (entry.knownStale) continue
      const keyEnvName = PROVIDER_REGISTRY[entry.providerId].keyEnvName
      if (!process.env[keyEnvName]?.trim()) continue // skip - no key configured
      steps.push({ catalogId: entry.id, providerId: entry.providerId, modelId: entry.modelId })
    }
    if (steps.length > 0) return steps
    // Configured chain exists but nothing in it currently has a key (e.g. the
    // user assigned a model then removed that provider's key) - fall through
    // to the legacy/default path rather than a guaranteed failure.
  }

  const legacy = legacyStep()
  if (legacy) return [legacy]

  const steps: ResolvedStep[] = []
  for (const id of DEFAULT_CATALOG_CHAIN[purpose]) {
    const entry = catalogEntry(id)
    if (!entry) continue
    if (entry.knownStale) continue
    const keyEnvName = PROVIDER_REGISTRY[entry.providerId].keyEnvName
    if (!process.env[keyEnvName]?.trim()) continue
    steps.push({ catalogId: entry.id, providerId: entry.providerId, modelId: entry.modelId })
  }
  return steps
}

function classifyReason(err: unknown): string {
  if (err instanceof AIProviderError) return err.code
  if (err instanceof Error && err.name === 'AbortError') return 'timeout'
  return 'failed'
}

/** The provider's own descriptive message, when it has one - surfaced in the
 *  fallback-event log so a structural bug (e.g. a provider rejecting the
 *  request shape outright) is diagnosable from Settings without needing to
 *  reproduce it - a generic 'failed' code alone hid exactly this once. */
function detailFrom(err: unknown): string | undefined {
  if (err instanceof AIProviderError) return err.message
  if (err instanceof Error) return err.message
  return undefined
}

/** The single entry point for every M20-aware call site. `req.purpose` is
 *  read from `req` itself (same field every provider already reads), so
 *  callers pass their existing AICompletionRequest unchanged. */
export async function completeWithFallback(req: AICompletionRequest): Promise<AICompletionResult> {
  const purpose = req.purpose
  const chain = resolveChain(purpose)

  if (chain.length === 0) {
    throw new AIProviderError('no-key', 'No AI provider is configured for this yet.')
  }

  const budget = CHAIN_BUDGET[purpose]
  let remainingBudgetMs = budget?.totalBudgetMs ?? 0
  const attempts: { catalogId: string; reason: string }[] = []
  const attempted = new Set<string>() // defense-in-depth: chain is already deduped by construction

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]
    if (attempted.has(step.catalogId)) continue
    attempted.add(step.catalogId)

    const key = process.env[PROVIDER_REGISTRY[step.providerId].keyEnvName]?.trim()
    if (!key) continue // resolved eagerly above, but env could change mid-loop in theory
    const provider = PROVIDER_REGISTRY[step.providerId].build(key)

    // Only 'coaching-cue' has a CHAIN_BUDGET entry - M9 already fixed one
    // multi-second dead-air regression on this exact live path, and giving
    // every chain entry its own full LATENCY_POLICY timeout independently
    // would reintroduce a worse version of it (see types.ts's CHAIN_BUDGET
    // doc comment). Every other purpose is post-call, not time-critical the
    // same way, so it keeps using LATENCY_POLICY's uncapped per-attempt
    // timeout (handled inside the provider itself).
    let attemptSignal = req.signal
    let budgetController: AbortController | null = null
    if (budget) {
      const remainingEntries = chain.length - i
      const perAttemptMs = Math.max(500, Math.floor(remainingBudgetMs / remainingEntries))
      budgetController = new AbortController()
      setTimeout(() => budgetController?.abort(), perAttemptMs)
      attemptSignal = req.signal
        ? AbortSignal.any([req.signal, budgetController.signal])
        : budgetController.signal
    }

    const startedAt = Date.now()
    try {
      const result = await provider.complete({
        ...req,
        model: step.modelId || undefined, // '' for a legacy step - let the provider use its own default
        signal: attemptSignal
      })
      return result
    } catch (err) {
      const reason = classifyReason(err)
      const detail = detailFrom(err)
      attempts.push({ catalogId: step.catalogId, reason: detail ? `${reason}: ${detail}` : reason })
      const nextStep = chain[i + 1] ?? null
      void logFallbackEvent({
        ts: new Date().toISOString(),
        purpose,
        fromCatalogId: step.catalogId,
        toCatalogId: nextStep?.catalogId ?? null,
        reason,
        detail
      })
    } finally {
      if (budget) {
        remainingBudgetMs = Math.max(0, remainingBudgetMs - (Date.now() - startedAt))
      }
    }
  }

  throw new AllModelsExhaustedError(purpose, attempts)
}

// Re-exported so call sites and Settings only need one import site for the
// M20 latency-policy constant that drives the chain-length cap.
export { LATENCY_POLICY }
