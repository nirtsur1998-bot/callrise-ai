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
import { recordAiFailure, recordAiSuccess } from './purpose-health-store'
import {
  clearCooldown,
  isUsableFor,
  markPeriodExhausted,
  markRateLimited,
  markStructurallyBroken,
  soonestExpiry
} from './model-cooldown'
import { markUsed } from './model-pacing'
import {
  AIProviderError,
  CHAIN_BUDGET,
  effectiveFailureClass,
  HARD_CEILING_MS,
  LATENCY_POLICY,
  SAME_MODEL_RETRY_LIMIT,
  type AICompletionRequest,
  type AICompletionResult,
  type AIFailureClass,
  type AIProviderErrorCode,
  type AIProviderId,
  type AIPurpose,
  type CooldownTier
} from './types'

/** BUG-057 Phase 3 — founder's explicit ask: exactly one of three actions,
 *  always, instead of a flat join of raw reason codes that told a rep
 *  nothing about what to actually DO. 'auth' is checked via the raw reason
 *  string first (lossless — the code already distinguishes it) rather than
 *  folded into 'structural', so an all-revoked-keys chain reads as "add/fix
 *  a key," not "report a bug." Order matters: auth beats structural beats
 *  period-exhausted beats the generic wait-and-retry default, since a key
 *  problem is both the most actionable and the most likely single cause
 *  when every attempt shares it. */
export function summarizeExhaustion(
  attempts: { reason: string; failureClass?: AIFailureClass }[]
): { kind: 'wait' | 'add-key' | 'bug'; message: string } {
  // Guards the `.every()` checks below from a vacuous truth on an empty
  // array: `chain.length > 0` is checked before the walk starts, but every
  // entry can still `continue` past the actual attempt (e.g. a key that
  // resolved at chain-build time going missing mid-loop — the walker's own
  // comment already flags this as possible "in theory"), leaving `attempts`
  // empty even though the loop completed normally. Without this, an EMPTY
  // array would vacuously satisfy `attempts.every(a => a.reason.startsWith
  // ('auth'))` and claim "every configured key was rejected" for a case
  // where nothing was ever actually attempted.
  if (attempts.length === 0) {
    return {
      kind: 'wait',
      message: 'No AI model could be attempted just now. Try again shortly.'
    }
  }
  if (attempts.every((a) => a.reason.startsWith('auth'))) {
    return { kind: 'add-key', message: 'Every configured key was rejected — check your API keys in Settings.' }
  }
  const classes = attempts.map((a) => a.failureClass ?? 'transient')
  if (classes.every((c) => c === 'structural')) {
    return {
      kind: 'bug',
      message:
        'Every configured model rejected this request the same way — this looks like a bug, not a rate limit or a full key. Please report it.'
    }
  }
  if (classes.some((c) => c === 'period-exhausted') && classes.every((c) => c !== 'transient')) {
    return {
      kind: 'add-key',
      message:
        "Every model set up for this has hit its free-tier limit for now. Add another provider's key in Settings, or wait for it to reset."
    }
  }
  return {
    kind: 'wait',
    message:
      'Every configured model failed to respond just now — this is usually temporary. Try again shortly, or add another provider key in Settings for backup.'
  }
}

export class AllModelsExhaustedError extends Error {
  constructor(
    readonly purpose: AIPurpose,
    readonly attempts: { catalogId: string; reason: string; failureClass?: AIFailureClass }[]
  ) {
    super(summarizeExhaustion(attempts).message)
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
  // BUG-039 follow-up: 'other' (askCoach, custom trackers, objection-mining,
  // call-title, crm-notes, deal-risk) used to call getActiveAIProvider()
  // directly instead of completeWithFallback() - a single pinned "Default
  // text AI provider" setting, not a real fallback chain, so a user with
  // e.g. only a Groq key (and the default still pointed at Claude) saw these
  // features fail outright even though live coaching cues worked fine on the
  // exact same key. No Settings UI lets a user assign a specific model to
  // 'other' (same as before), but it now gets the same bundled QUALITY_CHAIN
  // resilience every other non-configured purpose already has.
  other: QUALITY_CHAIN,
  'prep-brief': QUALITY_CHAIN,
  // M24 - same speed-lane precedent as coaching-cue (see CHAIN_BUDGET's doc
  // comment in types.ts): a live, latency-critical path gets the fast chain,
  // capped the same way.
  'deal-tier1': SPEED_CHAIN.slice(0, dealTier1Cap),
  // M24 - quality-lane precedent, same as summary/scorecard/prep-brief; no
  // cap, since deal-tier2 has no CHAIN_BUDGET entry.
  'deal-tier2': QUALITY_CHAIN,
  // M23 Workstream B - quality-lane precedent, same as summary/scorecard.
  'coaching-chat': QUALITY_CHAIN,
  // M25 - fast/cheap-lane by design (spec: "fast model for extraction"),
  // same speed chain as coaching-cue/deal-tier1, but no CHAIN_BUDGET entry
  // since this isn't a live-latency path — the full chain is available.
  //
  // BUG-057 — speed lane FIRST (extraction is fixed-shape allowlist pulling,
  // not judgment work), but no longer speed lane ONLY. SPEED_CHAIN is
  // groq+cerebras exclusively, so on a machine with a groq key and a
  // rate-limited groq account, every "fallback" was another request to the
  // same 429. This purpose has no CHAIN_BUDGET and blocks nothing anyone is
  // watching, so a slower quality-lane model is strictly better than learning
  // nothing from the call at all.
  'memory-extract': [...new Set([...SPEED_CHAIN, ...QUALITY_CHAIN])],
  // Judgment work, quality-lane precedent same as summary/scorecard.
  'memory-consolidate': QUALITY_CHAIN,
  'memory-reflect': QUALITY_CHAIN
}

interface ResolvedStep {
  catalogId: string
  providerId: CatalogEntry['providerId']
  modelId: string
  /** BUG-057 — true only for the bundled entries appended BEHIND a legacy
   *  step: models the user never chose for this job. False for a configured
   *  chain's entries (the user authored that ordering, so falling back within
   *  it is the system doing exactly what they asked) and for the bundled-only
   *  branch (there is no "primary" there to have substituted for). Part 2 of
   *  the design uses this to keep the "running on a substitute" notice rare
   *  and truthful — `chainIndex > 0` would also fire on a chain the user
   *  wrote themselves. */
  fromImplicitTail?: boolean
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

/**
 * BUG-057 — how many BUNDLED fallback entries may sit behind the legacy step.
 *
 * Exhaustive Record, not Partial, and deliberately NOT derived from
 * CHAIN_BUDGET: a 13th purpose must force a decision here rather than
 * silently inheriting a number nobody chose for it — the same convention
 * LATENCY_POLICY and DEFAULT_CATALOG_CHAIN already use.
 *
 * 0 for the two live paths. Their whole budget is the point (see CHAIN_BUDGET
 * in types.ts — M9 already fixed one multi-second dead-air regression on this
 * exact path), and they are the only two purposes whose exhaustion is ALREADY
 * visible to the rep via LiveView's "coaching cues temporarily unavailable"
 * banner. Silence was never their failure mode, so they are not what BUG-057
 * is for. Setting 0 makes this change provably zero-risk on live latency:
 * chain.length stays 1, so the per-attempt budget arithmetic is bit-identical.
 *
 * 1 where a human is watching a spinner: 'other' carries askCoach() (mid-call,
 * the rep is blocked on it) and 'coaching-chat' is the only streamWithFallback
 * consumer. One retry on a DIFFERENT provider is worth the wait; a third and
 * fourth are not.
 *
 * 3 elsewhere: enough to cross two or three providers on a typical key set,
 * bounded enough that a doomed call costs 4 requests instead of 9. If four
 * models across every provider you hold a key for fail within seconds of each
 * other, what is broken is the account, the network, or the request shape —
 * not the model.
 */
const LEGACY_TAIL_MAX: Record<AIPurpose, number> = {
  'coaching-cue': 0,
  'deal-tier1': 0,
  other: 1,
  'coaching-chat': 1,
  summary: 3,
  scorecard: 3,
  tasks: 3,
  'prep-brief': 3,
  'deal-tier2': 3,
  'memory-extract': 3,
  'memory-consolidate': 3,
  'memory-reflect': 3
}

/** The bundled-chain resolution, extracted verbatim from resolveChain's own
 *  tail so the legacy branch can REACH it instead of short-circuiting past
 *  it. Unchanged logic: catalog-known, not knownStale, provider key present.
 *  The key check must stay read-fresh from process.env on every resolution —
 *  ai-keys.ts sets and deletes those vars mid-session. */
function bundledSteps(purpose: AIPurpose): ResolvedStep[] {
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

/** BUG-057 Phase 6 — every step whose provider has a configured key,
 *  unfiltered by tool-calling capability; and `capable`, the same list
 *  further filtered when the caller needs one. Equal to `configured` when
 *  `needsTool` is false/omitted. Kept as two separate counts (not one
 *  collapsed empty-array case) so a caller can tell "no keys configured at
 *  all" apart from "keys exist but none of the assigned models support
 *  tools" — the first pass's version filtered internally and then re-ran
 *  the same idempotent filter on the already-filtered result, a check that
 *  could never fire; only the caller has both counts, since this is where
 *  the filtering actually happens. */
export interface ResolvedChain {
  configured: ResolvedStep[]
  capable: ResolvedStep[]
}

// The pre-Phase-6 resolution logic, verbatim — still exported under its old
// name for direct unit testing (mocking loadAppSettings + process.env is
// simpler and faster than driving the whole completeWithFallback path).
// resolveChain() below wraps this with the capability filter.
export function resolveConfiguredChain(purpose: AIPurpose): ResolvedStep[] {
  const configuredIds = loadAppSettings().aiModelAssignments[purpose].chain
  const candidateIds = configuredIds.length > 0 ? configuredIds : null

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

  // BUG-057 — this used to be `if (legacy) return [legacy]`: the legacy step
  // was the WHOLE chain. One attempt, zero fallback, for every purpose with
  // an empty chain — which on a FRESH INSTALL is all twelve (see
  // DEFAULT_MODEL_ASSIGNMENTS, empty for every purpose, plus an aiProvider
  // that maybeAutoSelectProvider sets on the first key saved), and on an
  // established install is every purpose the Settings picker cannot reach.
  // Against a rate-limited provider that is a feature which fails every
  // single time and says nothing: two days of Sales Brain learning nothing
  // from any call, with every surface in the product reporting success.
  //
  // The legacy step still goes FIRST, so an existing M16 install's first
  // attempt is byte-identical to before — the promise this file's header
  // makes. Only what happens AFTER it fails is new.
  const legacy = legacyStep()
  if (!legacy) return bundledSteps(purpose)

  const tailMax = LEGACY_TAIL_MAX[purpose]
  // Computed before bundledSteps() so the live paths do no extra work at all:
  // coaching-cue re-resolves this every few seconds mid-call.
  if (tailMax === 0) return [legacy]

  // Never re-issue the identical request as a later "fallback". The dedupe in
  // completeWithFallback works on catalogId, and a synthetic `legacy:<id>` can
  // never match a real catalog id — so without this, a single-key user's
  // attempt 1 and attempt 3 were literally the same call (six of eight
  // providers' default model IS a catalog entry's modelId — see
  // ProviderRegistryEntry.defaultModelId).
  const legacyModelId = PROVIDER_REGISTRY[legacy.providerId].defaultModelId
  const usable = bundledSteps(purpose).filter(
    (s) => legacyModelId === undefined || s.modelId !== legacyModelId
  )

  // Different providers FIRST, then at most ONE same-provider model.
  // Dropping same-provider entries entirely would leave memory-extract
  // (whose bundled chain is groq+cerebras only) with nothing behind a groq
  // legacy step; leaving them in order would make the first "fallback" behind
  // a google legacy step be google-gemini-flash — the account that just 429'd.
  // One is kept because Groq and Gemini rate-limit PER-MODEL, so a different
  // model on the same key genuinely can succeed; only one, because if two
  // models on that key fail, the account is the problem, not the model.
  const others = usable.filter((s) => s.providerId !== legacy.providerId)
  const same = usable.filter((s) => s.providerId === legacy.providerId).slice(0, 1)
  const tail = [...others, ...same]
    .slice(0, tailMax)
    .map((s) => ({ ...s, fromImplicitTail: true }))
  return [legacy, ...tail]
}

/** BUG-057 Phase 6 — resolveConfiguredChain() unchanged, plus an optional
 *  tool-calling capability filter. `capable` equals `configured` when
 *  `needsTool` is false/omitted, so every existing caller that never passes
 *  `opts` sees identical behavior to before this phase. */
export function resolveChain(purpose: AIPurpose, opts?: { needsTool?: boolean }): ResolvedChain {
  const configured = resolveConfiguredChain(purpose)
  const capable = opts?.needsTool
    ? configured.filter((s) => catalogEntry(s.catalogId)?.supportsToolCalling !== false)
    : configured
  return { configured, capable }
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

/**
 * BUG-058/BUG-059 — resolves EARLY when `signal` aborts, and never rejects.
 * Abort means "wake up now", not a failure; a caller that needs to unwind
 * checks the signal itself. Mirrors the (unused-in-practice — see
 * providers/anthropic.ts) pattern the Anthropic SDK's own sleep() uses.
 * `signal` is optional so this also serves streamWithFallback, which has no
 * combined ceiling/budget signal to offer — only whatever req.signal a
 * caller happened to pass, if any.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * BUG-058/BUG-059 — the ONLY retries a single step gets now. Every SDK call
 * site sets `maxRetries: 0` (see providers/*.ts) because the SDKs' own retry
 * sleep is unabortable and uncapped, driven by whatever the provider's
 * Retry-After header says — a 429 with a large hint made a "retry" sleep for
 * however long the header said, bypassing HARD_CEILING_MS entirely and
 * bypassing model-cooldown.ts's markRateLimited() (which can't fire until
 * the call returns). Verified by reading the vendored SDK source.
 *
 * Deliberately scoped to 'network'/'timeout' ONLY — the two failure modes
 * that are unambiguously connection-level blips, the exact thing the SDKs'
 * own default retry used to silently absorb. Removing the SDK's retry
 * without an equivalent here would trade one bug (uncapped, unabortable
 * waits) for another (every transient blip immediately burns a chain entry
 * instead of a quick retry). NEVER 'rate-limit' — model-cooldown.ts already
 * replaces "retry the same model" with "back off this model, try a
 * different one", and retrying immediately would just repeat the 429.
 * NEVER 'failed' — a 400/tool-schema rejection fails identically every
 * time (BUG-057's own finding); retrying it is pure waste.
 *
 * Bounded by SAME_MODEL_RETRY_LIMIT[purpose] (types.ts) — deliberately NOT
 * the old LATENCY_POLICY.maxRetries count reused unexamined: those numbers
 * were tuned for the SDK's own broader retry predicate and were never
 * checked against HARD_CEILING_MS, the thing that actually bounds a step's
 * total time now. See that constant's own doc comment for the computed
 * worst-case-vs-ceiling numbers that justify the smaller cap. `signal`
 * gates both the retry wait and every attempt, so this is fully abortable
 * where the SDK's own loop was not.
 */
async function completeWithSameModelRetry(
  provider: { complete: (req: AICompletionRequest) => Promise<AICompletionResult> },
  req: AICompletionRequest,
  modelId: string,
  signal: AbortSignal,
  purpose: AIPurpose
): Promise<AICompletionResult> {
  const maxAttempts = 1 + SAME_MODEL_RETRY_LIMIT[purpose]
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw lastErr ?? new AIProviderError('timeout', 'Aborted.')
    try {
      return await provider.complete({ ...req, model: modelId || undefined, signal })
    } catch (err) {
      lastErr = err
      const reason = classifyReason(err)
      const retryable = reason === 'network' || reason === 'timeout'
      if (!retryable || attempt === maxAttempts - 1) throw err
      // Short, bounded backoff — this is a connection blip, not a rate
      // limit; there is no provider-stated wait to honour here.
      await abortableSleep(Math.min(200 * 2 ** attempt, 2_000), signal)
    }
  }
  throw lastErr
}

/** The single entry point for every M20-aware call site. `req.purpose` is
 *  read from `req` itself (same field every provider already reads), so
 *  callers pass their existing AICompletionRequest unchanged. */
export async function completeWithFallback(req: AICompletionRequest): Promise<AICompletionResult> {
  const purpose = req.purpose
  const { configured, capable } = resolveChain(purpose, { needsTool: Boolean(req.tool) })
  // BUG-057 Phase 5 — CHAIN_BUDGET is exactly the two live, latency-critical
  // purposes (coaching-cue, deal-tier1); everything else is 'durable'. See
  // model-cooldown.ts's CooldownTier doc comment for what this drives.
  const tier: CooldownTier = purpose in CHAIN_BUDGET ? 'live' : 'durable'

  if (configured.length === 0) {
    void recordAiFailure(purpose, { reason: 'no-key', providerId: null })
    throw new AIProviderError('no-key', 'No AI provider is configured for this yet.')
  }
  if (capable.length === 0) {
    // BUG-057 Phase 6 — configured.length > 0 here by construction: real
    // keys ARE configured, none of them are verified to support forced tool
    // calls. Distinct from the no-key case above (and from the cooldown
    // case below) — a different problem with a different fix (reassign a
    // model in Settings, not add/wait for a key).
    void recordAiFailure(purpose, {
      reason: 'failed',
      providerId: null,
      detail: 'no configured model verified to support tool calling'
    })
    throw new AIProviderError(
      'failed',
      "Every model configured for this can't run this request (tool-calling not supported by any of them) — reassign a model in Settings.",
      undefined,
      'structural'
    )
  }

  // BUG-058 — skip models that just rate-limited us. Filtered HERE rather
  // than inside resolveChain, so resolution stays a pure function of settings
  // + keys, and so the "everything is cooling down" case below can tell the
  // difference between "you have no keys" and "your keys need a minute".
  const startedNow = Date.now()
  const chain = capable.filter((s) => isUsableFor(s.catalogId, startedNow, tier))

  if (chain.length === 0) {
    // Every model is in cooldown. Refusing here is the POINT: walking the
    // chain anyway spends a doomed request on each one and pushes their
    // limits out further, which is the spiral this fix exists to break.
    // Reported as a wait, with a number, rather than a generic failure.
    const until = soonestExpiry(
      capable.map((s) => s.catalogId),
      startedNow,
      tier
    )
    const secs = until ? Math.max(1, Math.ceil((until - startedNow) / 1000)) : 60
    void recordAiFailure(purpose, { reason: 'rate-limit', providerId: null })
    throw new AIProviderError(
      'rate-limit',
      `Every model set up for this is rate-limited right now. Try again in about ${secs}s.`,
      until ? until - startedNow : undefined
    )
  }

  const budget = CHAIN_BUDGET[purpose]
  let remainingBudgetMs = budget?.totalBudgetMs ?? 0
  const attempts: { catalogId: string; reason: string; failureClass?: AIFailureClass }[] = []
  // BUG-057 Part 3 — the LAST attempt's classified info, for whichever
  // exhaustion throw ends this call. purpose-health.ts's own doc comment is
  // explicit that a failure record is per-CALL, not per-step (`attempts`
  // above already carries every step for the log/message; this is only the
  // final one, the same "N in a row" unit the rest of that module counts
  // in), so this is tracked here rather than recorded inside the per-step
  // catch block below.
  let lastAttempt: { reason: AIProviderErrorCode; providerId: AIProviderId; detail?: string } | null =
    null
  const attempted = new Set<string>() // defense-in-depth: chain is already deduped by construction
  // BUG-057 — an invalid or revoked key fails IDENTICALLY on every model that
  // provider offers, so once one step returns 'auth', every remaining step on
  // the same provider is a guaranteed-doomed request. Skipping them is what
  // keeps the new fallback tail from being "just slower failure" for a
  // single-key user with a bad key. Deliberately NOT extended to
  // 'rate-limit': Groq and Gemini rate-limit per-MODEL, so a different model
  // on the same key really can succeed.
  const deadProviders = new Set<AIProviderId>()

  // BUG-059 — one hard wall-clock ceiling across the ENTIRE walk, including
  // each SDK's own internal retries (the signal below is threaded all the way
  // into the SDK call, so aborting it cuts a retry loop mid-flight). Without
  // this, our chain bound and the SDK's retry bound multiply unbounded: up to
  // ~27 minutes for one summary, with no way to cancel out of it.
  const ceiling = new AbortController()
  const ceilingTimer = setTimeout(() => ceiling.abort(), HARD_CEILING_MS[purpose])

  try {
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]
    if (ceiling.signal.aborted) break
    if (attempted.has(step.catalogId)) continue
    attempted.add(step.catalogId)
    if (deadProviders.has(step.providerId)) continue

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
    let budgetController: AbortController | null = null
    let budgetTimer: ReturnType<typeof setTimeout> | null = null
    if (budget) {
      const remainingEntries = chain.length - i
      const perAttemptMs = Math.max(500, Math.floor(remainingBudgetMs / remainingEntries))
      budgetController = new AbortController()
      budgetTimer = setTimeout(() => budgetController?.abort(), perAttemptMs)
    }
    // The ceiling is ALWAYS in the combined signal — that is what makes it
    // bound the SDK's retries and not just our own loop.
    const parts: AbortSignal[] = [ceiling.signal]
    if (req.signal) parts.push(req.signal)
    if (budgetController) parts.push(budgetController.signal)
    const attemptSignal = parts.length === 1 ? parts[0] : AbortSignal.any(parts)

    const startedAt = Date.now()
    try {
      // '' modelId is a legacy step - let the provider use its own default.
      const result = await completeWithSameModelRetry(provider, req, step.modelId, attemptSignal, purpose)
      // Proof the limit lifted — trust that over any earlier estimate.
      clearCooldown(step.catalogId)
      // BUG-058 remainder — a success is real evidence this model's capacity
      // was just spent, exactly like a rate-limit failure below is; a
      // DIFFERENT durable purpose asking again in the next few seconds
      // should try elsewhere first. Marked on the real outcome, not before
      // the attempt — see the 'rate-limit' branch below for why a plain
      // failure deliberately does NOT mark this.
      markUsed(step.catalogId, Date.now(), tier)
      void recordAiSuccess(purpose, { providerId: step.providerId, fromImplicitTail: !!step.fromImplicitTail })
      return result
    } catch (err) {
      const reason = classifyReason(err)
      const detail = detailFrom(err)
      const failureClass = err instanceof AIProviderError ? effectiveFailureClass(err) : 'transient'
      lastAttempt = { reason: reason as AIProviderErrorCode, providerId: step.providerId, detail }
      if (reason === 'auth') deadProviders.add(step.providerId)
      // BUG-058 — honour the provider's own "come back in N seconds" so the
      // next call skips this model instead of re-burning it. Without this,
      // every subsequent call restarted at position 1 and hit the same 429.
      // BUG-057 Phase 2 — a period-exhausted 429 (quota/billing, not an
      // ordinary throttle) gets the longer period-exhausted default instead
      // of the ordinary 60s guess; retrying inside a quota window is pure
      // waste, not just impolite.
      if (reason === 'rate-limit' && failureClass === 'period-exhausted') {
        markPeriodExhausted(
          step.catalogId,
          err instanceof AIProviderError ? err.retryAfterMs : undefined,
          Date.now(),
          tier
        )
        // BUG-058 remainder — pacing marks alongside cooldown, deliberately
        // ONLY on a rate-limit-classified failure (same condition as this
        // branch and the sibling one below), never on a plain 'failed' —
        // "only rate limits cool down... applying it to every failure would
        // sideline healthy models after one blip" is model-cooldown.ts's own
        // established rule for cooldown; pacing follows the identical rule
        // for the identical reason. A structural/generic error tells us
        // nothing about this model being near a shared capacity limit.
        markUsed(step.catalogId, Date.now(), tier)
      } else if (reason === 'rate-limit') {
        markRateLimited(
          step.catalogId,
          err instanceof AIProviderError ? err.retryAfterMs : undefined,
          Date.now(),
          tier
        )
        markUsed(step.catalogId, Date.now(), tier)
      } else if (failureClass === 'structural' && reason !== 'auth') {
        // 'auth' already gets a coarser, PROVIDER-wide skip (deadProviders,
        // above) — checking the raw reason string here, not re-deriving from
        // failureClass (which would also say 'structural' for auth), avoids
        // two independent encodings of the same exclusion drifting apart.
        markStructurallyBroken(step.catalogId, Date.now())
      }
      attempts.push({
        catalogId: step.catalogId,
        reason: detail ? `${reason}: ${detail}` : reason,
        failureClass
      })
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
      // Left dangling before BUG-057: the abort fired after a SUCCESSFUL
      // return too, on an AbortController nothing was listening to any more.
      // Harmless in practice, but it kept a timer alive past the call for as
      // long as the budget allowed.
      if (budgetTimer) clearTimeout(budgetTimer)
      if (budget) {
        remainingBudgetMs = Math.max(0, remainingBudgetMs - (Date.now() - startedAt))
      }
    }
  }
  } finally {
    clearTimeout(ceilingTimer)
  }

  if (ceiling.signal.aborted) {
    // Distinct from AllModelsExhaustedError on purpose: "we ran out of time"
    // and "every model rejected us" are different problems with different
    // user actions, and collapsing them is how the 27-minute path stayed
    // invisible. Surfaced as an AIProviderError so the existing
    // friendlyError() handlers pass the real message through to the user.
    void recordAiFailure(purpose, {
      reason: 'timeout',
      providerId: lastAttempt?.providerId ?? null,
      detail: lastAttempt?.detail
    })
    throw new AIProviderError(
      'timeout',
      `This took too long and was stopped after ${Math.round(HARD_CEILING_MS[purpose] / 1000)}s. Your AI provider may be rate-limiting or slow right now — try again shortly.`
    )
  }

  void recordAiFailure(purpose, {
    reason: lastAttempt?.reason ?? 'failed',
    providerId: lastAttempt?.providerId ?? null,
    detail: lastAttempt?.detail
  })
  throw new AllModelsExhaustedError(purpose, attempts)
}

export interface StreamWithFallbackResult extends AsyncIterable<{ delta: string }> {
  /** Resolves once the stream ends successfully (final text + a best-effort
   *  model label + usage). Rejects only when every chain entry failed
   *  BEFORE any delta was ever yielded — once a delta has reached the
   *  caller, a mid-stream failure rejects too (there's no clean way to
   *  restart with a different model without confusing whoever's reading
   *  the partial text), but the caller already has that partial text from
   *  the deltas it already saw. */
  final: Promise<{ text: string; model: string; usage: AICompletionResult['usage'] }>
}

/**
 * M23 Workstream B — the first real caller of AIProvider.stream(). Same
 * chain-resolution/purpose/settings semantics as completeWithFallback()
 * (reuses resolveChain() directly), but yields text deltas as they arrive
 * instead of waiting for one full response.
 *
 * Fallback only ever happens BEFORE the first delta of a given attempt —
 * once tokens have started flowing to the caller, switching models
 * mid-stream would silently splice two different voices together, so a
 * failure past that point ends the stream with an error instead.
 */
export function streamWithFallback(req: AICompletionRequest): StreamWithFallbackResult {
  const purpose = req.purpose
  const { configured, capable } = resolveChain(purpose, { needsTool: Boolean(req.tool) })
  // BUG-057 Phase 5 — coaching-chat (the only consumer today) isn't in
  // CHAIN_BUDGET, so this is always 'durable' currently; computed the same
  // way as completeWithFallback rather than hardcoded, so a future live
  // streaming consumer gets the right tier automatically.
  const tier: CooldownTier = purpose in CHAIN_BUDGET ? 'live' : 'durable'
  // BUG-058 — same cooldown filter as completeWithFallback: a model that just
  // 429'd must not be re-burned here either. coaching-chat is the only
  // consumer, and it is interactive, so spending its first attempt on a model
  // we already know is limited is the most visible possible version of this.
  const startedNow = Date.now()
  const chain = capable.filter((s) => isUsableFor(s.catalogId, startedNow, tier))

  let resolveFinal!: (v: { text: string; model: string; usage: AICompletionResult['usage'] }) => void
  let rejectFinal!: (e: unknown) => void
  const final = new Promise<{ text: string; model: string; usage: AICompletionResult['usage'] }>(
    (resolve, reject) => {
      resolveFinal = resolve
      rejectFinal = reject
    }
  )

  async function* generator(): AsyncGenerator<{ delta: string }> {
    if (configured.length === 0) {
      void recordAiFailure(purpose, { reason: 'no-key', providerId: null })
      const err = new AIProviderError('no-key', 'No AI provider is configured for this yet.')
      rejectFinal(err)
      throw err
    }
    if (capable.length === 0) {
      // BUG-057 Phase 6 — configured.length > 0 here by construction: real
      // keys ARE configured, none of them are verified to support forced
      // tool calls. Distinct from the no-key case above and the cooldown
      // case below — same three-way split as completeWithFallback.
      void recordAiFailure(purpose, {
        reason: 'failed',
        providerId: null,
        detail: 'no configured model verified to support tool calling'
      })
      const err = new AIProviderError(
        'failed',
        "Every model configured for this can't run this request (tool-calling not supported by any of them) — reassign a model in Settings.",
        undefined,
        'structural'
      )
      rejectFinal(err)
      throw err
    }
    if (chain.length === 0) {
      // BUG-057 Phase 2 — configured.length > 0 here by construction: real
      // keys ARE configured, every entry is just cooling down right now.
      // Before this, this case hit the SAME branch as genuinely-no-keys
      // above, telling a user with valid keys "No AI provider is configured
      // for this yet" — see complete-with-fallback.ts's own identical
      // pattern (the non-streaming path already got this right).
      const until = soonestExpiry(
        capable.map((s) => s.catalogId),
        startedNow,
        tier
      )
      const secs = until ? Math.max(1, Math.ceil((until - startedNow) / 1000)) : 60
      void recordAiFailure(purpose, { reason: 'rate-limit', providerId: null })
      const err = new AIProviderError(
        'rate-limit',
        `Every model set up for this is rate-limited right now. Try again in about ${secs}s.`,
        until ? until - startedNow : undefined
      )
      rejectFinal(err)
      throw err
    }

    let fullText = ''
    let startedStreaming = false
    let lastErr: unknown = null
    // BUG-057 Part 3 — same per-CALL (not per-step) tracking as
    // completeWithFallback's lastAttempt; see that function's identical
    // field for the full reasoning.
    let lastAttempt: { reason: AIProviderErrorCode; providerId: AIProviderId; detail?: string } | null =
      null
    const attempts: { catalogId: string; reason: string; failureClass?: AIFailureClass }[] = []

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]
      const key = process.env[PROVIDER_REGISTRY[step.providerId].keyEnvName]?.trim()
      if (!key) continue
      const provider = PROVIDER_REGISTRY[step.providerId].build(key)

      // BUG-058/BUG-059 — the SDK's own retry is now always off (maxRetries:
      // 0, see providers/*.ts's stream()): its sleep was unabortable and
      // uncapped, driven by whatever the provider's own header said. This
      // sub-loop is the replacement, scoped to the SAME pre-first-delta
      // window the file's own fallback logic already respects — a network/
      // timeout blip before any token has reached the caller gets ONE quick
      // retry of the SAME model; once streaming has started, this loop
      // exits immediately on the next line's check and the existing
      // never-retry-mid-stream behavior below is unchanged.
      const maxAttempts = 1 + SAME_MODEL_RETRY_LIMIT[purpose]
      let stepErr: unknown = null
      let stepStartedStreaming = false

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const streamResult = provider.stream({
            ...req,
            model: step.modelId || undefined
          })
          for await (const chunk of streamResult) {
            startedStreaming = true
            stepStartedStreaming = true
            fullText += chunk.delta
            yield chunk
          }
          const usage = await streamResult.usage
          clearCooldown(step.catalogId)
          // BUG-058 remainder — same reasoning as completeWithFallback: mark
          // on the real outcome (success), never on a plain failure.
          markUsed(step.catalogId, Date.now(), tier)
          void recordAiSuccess(purpose, { providerId: step.providerId, fromImplicitTail: !!step.fromImplicitTail })
          resolveFinal({ text: fullText, model: step.modelId || `${step.providerId} (default)`, usage })
          return
        } catch (err) {
          stepErr = err
          if (stepStartedStreaming) break // tokens already shipped — never retried, handled below
          const reason = classifyReason(err)
          const retryable = reason === 'network' || reason === 'timeout'
          if (retryable && attempt < maxAttempts - 1) {
            await abortableSleep(Math.min(200 * 2 ** attempt, 2_000), req.signal)
            continue
          }
          break
        }
      }

      {
        const err = stepErr
        lastErr = err
        const reason = classifyReason(err)
        const detail = detailFrom(err)
        lastAttempt = { reason: reason as AIProviderErrorCode, providerId: step.providerId, detail }
        const failureClass = err instanceof AIProviderError ? effectiveFailureClass(err) : 'transient'
        if (reason === 'rate-limit' && failureClass === 'period-exhausted') {
          markPeriodExhausted(
            step.catalogId,
            err instanceof AIProviderError ? err.retryAfterMs : undefined,
            Date.now(),
            tier
          )
          // BUG-058 remainder — same reasoning as completeWithFallback's
          // identical branch: pacing marks alongside cooldown only on a
          // rate-limit-classified failure, never a plain one.
          markUsed(step.catalogId, Date.now(), tier)
        } else if (reason === 'rate-limit') {
          markRateLimited(
            step.catalogId,
            err instanceof AIProviderError ? err.retryAfterMs : undefined,
            Date.now(),
            tier
          )
          markUsed(step.catalogId, Date.now(), tier)
        } else if (failureClass === 'structural' && reason !== 'auth') {
          markStructurallyBroken(step.catalogId, Date.now())
        }
        attempts.push({
          catalogId: step.catalogId,
          reason: detail ? `${reason}: ${detail}` : reason,
          failureClass
        })
        const nextStep = chain[i + 1] ?? null
        void logFallbackEvent({
          ts: new Date().toISOString(),
          purpose,
          fromCatalogId: step.catalogId,
          toCatalogId: startedStreaming ? null : (nextStep?.catalogId ?? null),
          reason,
          detail
        })
        if (startedStreaming) {
          // BUG-057 Part 3 — recorded as a failure even though the caller
          // did receive some real output: purpose-health's severity model
          // is binary (this call either completed cleanly or it didn't),
          // and a mid-stream cutoff genuinely isn't "it worked" from the
          // rep's point of view — a simplification, not a fully-reasoned
          // partial-success case, noted rather than silently assumed.
          void recordAiFailure(purpose, { reason: reason as AIProviderErrorCode, providerId: step.providerId, detail })
          const streamErr =
            err instanceof AIProviderError
              ? err
              : new AIProviderError('failed', 'The response was interrupted. Please try again.')
          rejectFinal(streamErr)
          throw streamErr
        }
        // Nothing shown yet — safe to fall through and try the next entry.
      }
    }

    // Unconditional, matching completeWithFallback()'s own exhaustion
    // behavior above — every entry failing before any delta shipped means
    // the chain is exhausted, the same outcome regardless of what kind of
    // error the last entry happened to throw (lastErr is already captured
    // per-attempt in `attempts` for diagnostics).
    void lastErr
    void recordAiFailure(purpose, {
      reason: lastAttempt?.reason ?? 'failed',
      providerId: lastAttempt?.providerId ?? null,
      detail: lastAttempt?.detail
    })
    const finalErr = new AllModelsExhaustedError(purpose, attempts)
    rejectFinal(finalErr)
    throw finalErr
  }

  return Object.assign(generator(), { final })
}

// Re-exported so call sites and Settings only need one import site for the
// M20 latency-policy constant that drives the chain-length cap.
export { LATENCY_POLICY }
