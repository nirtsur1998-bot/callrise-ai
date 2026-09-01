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
import { providerHasCredentials } from './provider-credentials'
import { getActiveAIProvider } from './index'
import { loadAppSettings } from '../app-settings'
import { catalogEntry, type CatalogEntry } from './model-catalog'
import { logFallbackEvent } from './fallback-log'
import { recordAiFailure, recordAiSuccess } from './purpose-health-store'
import {
  clearCooldown,
  cooldownUntil,
  isStructurallyBroken,
  structuralBreakReason,
  isUsableFor,
  markPeriodExhausted,
  markRateLimited,
  markStructurallyBroken,
  noteTransientFailure,
  soonestExpiry
} from './model-cooldown'
import { isDemoted, noteAuthRejection, clearDemotion } from './provider-demotion'
import { isPacedFor, pacedUntilFor, PACING_GAP_MS } from './model-pacing'
import { exhaustionReport } from './exhaustion-report'
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
    readonly attempts: { catalogId: string; reason: string; failureClass?: AIFailureClass }[],
    /**
     * BUG-125c (2026-08-28) — models that were NEVER ATTEMPTED, and why.
     *
     * Two field reports running showed a SINGLE attempt on a chain that should
     * have had several, and `attempts` alone can never explain that: it records
     * what ran, never what was excluded before the walk. I guessed at the
     * reason from here twice and was wrong both times, because the machine's
     * logs cannot leave it. So the error now carries the other half of the
     * picture — what was filtered out and by which gate — to be read straight
     * off the screen.
     */
    readonly notTried: { catalogId: string; why: string }[] = []
  ) {
    // BUG-125 closing move (2026-08-28, founder's directive): the per-model
    // breakdown is composed HERE, at the source, not per-surface. Thirteen
    // files check `instanceof AllModelsExhaustedError` and show err.message —
    // coaching chat, summaries, prep briefs, deal tiers, task generation and
    // more — and only Rise had been given the breakdown. The self-explaining
    // error is the actual deliverable of BUG-125's diagnosis loop (machines
    // whose logs cannot leave them get errors that ARE the log), so every
    // surface gets it by construction rather than by thirteen hand edits that
    // would drift.
    super(exhaustionReport(summarizeExhaustion(attempts).message, attempts, notTried))
    this.name = 'AllModelsExhaustedError'
  }
}

// BUG-154 (2026-09-01) — REORDERED AND WIDENED. This list was groq+cerebras
// ONLY, and its first two entries were both confirmed-dead Groq ids. Because
// it is also CANDIDATE_POOL for the two live purposes, a user holding keys for
// any other provider had NO reachable coaching-cue or deal-tier1 model at all
// — the feature was not degraded, it was absent. See the model-catalog entries
// for anthropic/openai for the full account.
//
// ORDERING PRINCIPLE, stated because it is a cost decision and not obvious:
// free-tier providers come FIRST and paid ones LAST. A fallback must never
// silently escalate a user's bill when a free option would have served, but a
// paid key must still be reachable rather than the feature dying — which is
// exactly what happened here. Dead entries are kept (not deleted) so the
// history and their knownStale evidence stay readable; they are filtered out
// by stepsFromIds and now sit at the back where they cannot consume a cap.
const SPEED_CHAIN = [
  'groq-gpt-oss-120b',
  'cerebras-gpt-oss-120b',
  'cloudflare-llama-3.1-8b-fast',
  // Paid tier — reachable, but only after every free option above.
  'anthropic-claude-haiku-4-5',
  'openai-gpt-5.4-mini',
  // LAST RESORT, and a deliberate lane violation — flagged as such rather than
  // hidden. Z.ai and Hugging Face are catalogued as QUALITY lane (the HF entry
  // says so explicitly: same weights as the Groq/Cerebras entries, but the
  // router is not fast). They are here anyway because the alternative, found by
  // this fix's own resolution test, is that a user holding ONLY one of those
  // keys gets no live cue at all — which is the bug being fixed, one provider
  // further down. A slow cue that the 6s CHAIN_BUDGET may cut off is strictly
  // better than a guaranteed absent one, and the budget bounds the cost of
  // being wrong about that. They sit behind every genuinely fast option, so a
  // user with any other key never pays for this.
  'zai-glm-4.5-flash',
  'hf-gpt-oss-20b',
  // BUG-159 — google and openrouter were in NO live-lane chain at all, so a
  // user holding only those keys had no cue fallback whatsoever: the same gap
  // zai and huggingface had before BUG-154. Quality-lane models on a live path
  // is a deliberate last resort, bounded by the 6s CHAIN_BUDGET — a slower
  // answer that may be cut off beats a guaranteed absent one — and they sit
  // behind every genuinely fast option, so nobody reaches them who does not
  // need to.
  'google-gemini-flash',
  'openrouter-nemotron-3.5-lightning',
  // knownStale, filtered by stepsFromIds; kept for provenance only.
  'groq-llama-3.1-8b-instant',
  'groq-llama-3.3-70b-versatile',
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
  'openrouter-nemotron-3.5-lightning', // M27 B2 — was 'openrouter-nemotron-3-ultra' (dead id, 100% 400s)
  'nvidia-glm-5.2',
  'mistral-small',
  // M27 B2 — openrouter-auto-free stays in the chain but is now
  // supportsToolCalling:false in the catalog, so on a tool-using purpose it
  // is filtered out (it failed 28/39 real attempts on tool-call output); on
  // a plain-text purpose it remains the last-resort entry it always was.
  'openrouter-auto-free',
  'groq-gpt-oss-120b',
  'cerebras-gpt-oss-120b',
  // BUG-154 — the remaining free/allowance providers this app accepts keys
  // for and which appeared in NO chain, so their keys were dead weight.
  'zai-glm-4.7-flash',
  'zai-glm-4.5-flash',
  'hf-gpt-oss-120b',
  'hf-gpt-oss-20b',
  'cloudflare-gpt-oss-120b',
  // BUG-154 — paid tier LAST, same cost principle as SPEED_CHAIN above: a
  // free option is always tried first, but a paid key is reachable instead of
  // the feature failing outright.
  'anthropic-claude-sonnet-4-6',
  'openai-gpt-5.4',
  // knownStale, filtered by stepsFromIds; kept for provenance only.
  'groq-llama-3.3-70b-versatile'
]

// BUG-154 — the two `SPEED_CHAIN.slice(0, cap)` constants that used to live
// here are gone, and the cap moved into bundledSteps() below. Slicing the RAW
// id list applied the cap BEFORE the liveness filter, so a cap of 2 whose
// first two ids were knownStale resolved to ZERO usable models — a cap that
// silently means "no attempts at all" rather than "at most two". The cap
// answers "how many attempts may this purpose make"; only reachable steps can
// be attempts, so it has to be applied to reachable steps.

/** Bundled fallback ordering, only reached when a purpose has neither an
 *  explicit chain configured nor a legacy `aiProvider`+key. Not lane-
 *  restricted for the same reason QUALITY_CHAIN isn't - see above. */
export const DEFAULT_CATALOG_CHAIN: Record<AIPurpose, string[]> = {
  'coaching-cue': SPEED_CHAIN,
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
  'deal-tier1': SPEED_CHAIN,
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
  'memory-reflect': QUALITY_CHAIN,
  // M28 - the Rise assistant chat. Quality-lane precedent, same as
  // coaching-chat: a real conversation the rep reads, never latency-critical.
  'assistant-chat': QUALITY_CHAIN
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
  // BUG-159 (founder, 2026-09-01): "I want all keys to work and if one fails
  // for the system to direct the work to it and won't deny a job from the
  // user and have any failures (EVEN WITHOUT A PAID API)."
  //
  // 0 -> 1. This REVERSES BUG-148 decision 5B ("the chain stays exactly one
  // step long", founder, 2026-08-31), recorded rather than quietly changed:
  // 5B spent the 6s dead-air budget on a single attempt, and the founder has
  // now weighed a missed cue as the worse outcome.
  //
  // THE BUDGET ALREADY PAID FOR IT. CHAIN_BUDGET declares maxChainLength 2 for
  // both live purposes; LEGACY_TAIL_MAX 0 meant that whenever a default was
  // pinned the chain was one step, so the second budgeted attempt could never
  // be spent. The two tables disagreed and the stricter silently won.
  //
  // MEASURED COST OF THE DISAGREEMENT, driving real calls: reaching a working
  // provider took SIX failed attempts over ~50s before the tail partition, and
  // still FOUR over ~32s after it — each provider needing three strikes to
  // bench before the next is tried, one model per attempt. Every one of those
  // is a cue the rep never saw.
  //
  // LATENCY IS UNCHANGED, and that was checked rather than assumed:
  // completeWithFallback divides remainingBudgetMs by the remaining entries,
  // so two attempts SHARE the six seconds instead of doubling them. Two is
  // also the ceiling — going past it needs CHAIN_BUDGET raised, which is a
  // real dead-air trade-off and a separate decision.
  'coaching-cue': 1,
  'deal-tier1': 1,
  other: 1,
  'coaching-chat': 1,
  // M28 - REVERSED from the original 1 (which copied coaching-chat's "human
  // watching a spinner" reasoning uncritically). Real field evidence
  // (ai-fallback-events.jsonl, 2026-08-21) showed why that was wrong for
  // Rise specifically: a single "send" walks this SAME purpose 2-3 times
  // (plan_research, the answer stream, the suggestion pass), all sharing
  // one thin tail — and unlike coaching-chat, Rise already shows a real
  // activity-phase indicator during this window, so the "spinner" cost the
  // original comment worried about doesn't apply the same way. With tail=1
  // and the founder's actual config (legacy:groq's default model dead on
  // Groq's live API + Gemini genuinely daily-quota-exhausted), the whole
  // chain collapsed to zero live links on the very first two entries. 3
  // matches the other quality-lane durable purposes and gives Rise the same
  // resilience summary/scorecard/coaching-chat already have.
  'assistant-chat': 3,
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
/** BUG-159 — the CONFIGURED set for a purpose: every catalog step whose
 *  provider has credentials and which is not knownStale, ignoring cooldowns,
 *  quota and structural breaks entirely, uncapped and unordered.
 *
 *  This exists because one resolution was being asked two different questions.
 *  The WALK wants unusable steps demoted or dropped; the CAPACITY check wants
 *  the complete set, because its "is this user set up at all?" branch keys off
 *  an EMPTY result. Sharing one view meant any change that shortened the chain
 *  silently inverted the capacity signal — a filtered chain empties exactly
 *  when everything is cooling, which capacity then read as "nothing
 *  configured, so capacity exists". Background jobs would stop deferring and
 *  hammer the very providers the user is trying to spread load across.
 *
 *  Deliberately NOT capped by CHAIN_BUDGET: an attempts budget answers "how
 *  many tries may this make", which has nothing to do with "how many models is
 *  this user set up with". */
export function configuredStepsFor(purpose: AIPurpose): ResolvedStep[] {
  return stepsFromIds(CANDIDATE_POOL[purpose] ?? DEFAULT_CATALOG_CHAIN[purpose])
}

export function bundledSteps(purpose: AIPurpose): ResolvedStep[] {
  const steps = stepsFromIds(DEFAULT_CATALOG_CHAIN[purpose])
  // BUG-154 — cap AFTER resolution, never before. See the note where the old
  // `SPEED_CHAIN.slice(0, cap)` constants used to be defined.
  const cap = CHAIN_BUDGET[purpose]?.maxChainLength
  return cap === undefined ? steps : steps.slice(0, cap)
}

/**
 * BUG-148 decision 5B — the pool a demoted live purpose may substitute FROM.
 *
 * `DEFAULT_CATALOG_CHAIN` caps the two live purposes to `SPEED_CHAIN.slice(0,
 * 2)`, and that cap answers "how many attempts may this purpose make" — a
 * different question from "which models are eligible". Substitution returns
 * exactly ONE step, so the length cap is already satisfied; restricting the
 * POOL to the capped prefix as well would have made 5B a no-op for the most
 * common configuration in this product.
 *
 * Concretely, and this was caught by its own test rather than reasoned about:
 * SPEED_CHAIN's first two entries are BOTH Groq, so a user whose default
 * provider is Groq — the free tier this app steers people to — had no
 * non-Groq candidate inside the cap, and a demoted Groq default fell straight
 * back to itself. The fix would have looked applied and done nothing.
 *
 * The uncapped chain is still the same LANE (SPEED_CHAIN is the fast lane end
 * to end), so a substitute is never a slower class of model than the capped
 * prefix would have offered.
 */
export const CANDIDATE_POOL: Record<AIPurpose, string[]> = {
  ...DEFAULT_CATALOG_CHAIN,
  'coaching-cue': SPEED_CHAIN,
  'deal-tier1': SPEED_CHAIN
}

function stepsFromIds(ids: string[]): ResolvedStep[] {
  const steps: ResolvedStep[] = []
  for (const id of ids) {
    const entry = catalogEntry(id)
    if (!entry) continue
    if (entry.knownStale) continue
    if (!providerHasCredentials(entry.providerId)) continue
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
      if (!providerHasCredentials(entry.providerId)) continue // skip - not configured
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

  // BUG-148 — has this provider been rejecting our credential?
  // Read once, here, so the two branches below cannot disagree about it.
  const legacyDemoted = isDemoted(legacy.providerId, Date.now())

  // BUG-154 follow-up (2026-09-01) — demotion is AUTH-ONLY, and that was the
  // whole remaining hole in the live path.
  //
  // 5B replaces a demoted legacy step on the two tailMax-0 purposes. But
  // noteAuthRejection() is only reached on reason === 'auth', so a default
  // provider failing for ANY OTHER persistent reason never demotes, never gets
  // replaced, and — having no tail to fall through to — is retried forever.
  //
  // Measured on the founder's machine: huggingface pinned as default, every
  // coaching-cue attempt failing with 'the model did not return the expected
  // structured output' every ~7 seconds for an entire call, logged as
  // 'legacy:huggingface -> null' each time. The same provider, failing the
  // same way in the same second, fell back correctly for the 'other' purpose,
  // which has a tail. Only the live purposes starved.
  //
  // A structural break is the right second trigger and not a new concept: it
  // is already recorded from real failures, already PURPOSE-SCOPED (so a
  // provider that cannot serve cues can still serve summaries), and already
  // self-heals on its own TTL. Reading it here costs one map lookup on a path
  // that re-resolves every few seconds.
  //
  // The founder's constraint is untouched: the chain is still EXACTLY ONE
  // step. Only which single attempt it buys changes.

  // Computed before bundledSteps() so the live paths do no extra work at all:
  // coaching-cue re-resolves this every few seconds mid-call.
  if (tailMax === 0) {
    // BUG-148 decision 5B (founder, 2026-08-31). The two live purposes
    // (coaching-cue, deal-tier1) have tailMax 0, so their chain is EXACTLY
    // [legacy] — there is nowhere to demote TO, and reordering alone would be
    // a no-op on the two purposes this bug costs the most.
    //
    // So a demoted legacy step is REPLACED rather than reordered, and the
    // chain stays exactly one step long. The founder's constraint was "one
    // extra step, not an open tail"; this spends none — the live budget is
    // unchanged, only WHICH single attempt it buys.
    //
    // Latency is not being spent either, and that was checked rather than
    // assumed: DEFAULT_CATALOG_CHAIN for both purposes is SPEED_CHAIN, the
    // explicitly fast lane, while the legacy step is whatever the user's
    // "default text AI provider" happens to be and is lane-BLIND — it can
    // easily be a large quality model. The substitute is, if anything, faster.
    //
    // "Reorder, never remove" still holds where it matters: demotion is
    // GLOBAL per provider, and the durable purposes (tailMax 3) keep the
    // demoted step at the back of their chains, so it is still attempted and
    // can still earn its own restoration. It is not orphaned by being skipped
    // on a 6-second live path.
  // COMPUTED INSIDE THIS BRANCH, NOT ABOVE IT, AND THAT IS LOAD-BEARING.
  //
  // isStructurallyBroken() MUTATES: an entry whose window has closed is
  // deleted on read. Hoisting this beside legacyDemoted (which is where it
  // first went, mirroring that constant's 'read once so the branches cannot
  // disagree' comment) therefore ran a purging lookup on EVERY purpose's
  // resolution, including the ones that never consult it.
  //
  // capacityForPurpose.test.ts caught it immediately: that suite records
  // breaks against a fixed fake clock, the hoisted read used the real
  // Date.now(), every such break read as long expired, and the lookup DELETED
  // the state the test had just written — so 'counts a structural break as
  // unusable' went green-to-red for a reason that had nothing to do with the
  // behaviour under test. In production the clocks agree and this would have
  // been invisible; it would still have been a resolution path quietly
  // clearing another purpose's evidence.
  //
  // Reading it only where it is used is both correct and cheaper.
  // WIDENED from isStructurallyBroken() to isUsableFor(), after the narrow
  // version was driven on a real call and did not fix the bug.
  //
  // A structural break is only ONE of the ways the pinned default can be
  // unavailable. Driving a live call with huggingface pinned showed the next
  // one immediately: its account hit quota, so it was marked PERIOD-EXHAUSTED
  // rather than broken, the substitution never triggered, and the walk simply
  // skipped its only step and attempted nothing at all — cues failed silently
  // instead of failing loudly, which is worse, not better.
  //
  // isUsableFor() is the codebase's own single gate for 'can this step be
  // attempted right now': cooldown, period-exhaustion and structural break,
  // one answer, no second encoding to drift (its own doc comment makes that
  // the point of the flag it takes). Demotion stays separate because it is
  // provider-scoped rather than catalog-id-scoped.
  //
  // ignorePacing: true deliberately. Pacing is OUR own 2-6s spacing, not the
  // provider refusing us; substituting on it would swap providers during any
  // ordinary burst and spend a different key for no reason.
    const legacyUsable = isUsableFor(legacy.catalogId, Date.now(), purposeTier(purpose), {
      ignorePacing: true,
      purpose
    })
    if (!legacyDemoted && legacyUsable) return [legacy]
    // The substitute must ALSO be usable, and leaving that out was the last
    // hole in this fix -- found by driving a third live call.
    //
    // stepsFromIds() filters knownStale and missing credentials. It does NOT
    // filter cooldowns, quota exhaustion or structural breaks. So once the
    // pinned default became unusable and substitution finally started firing,
    // it handed back the SAME first candidate every few seconds -- a Groq
    // model returning 400 'Tool choice is required, but model did not call a
    // tool', which is structural and was already recorded as such. The step
    // that had just been benched was re-picked immediately, eight times in a
    // row, because nothing consulted the bench.
    //
    // Same gate as the legacy check above, for the same reason: one encoding
    // of 'can this be attempted right now', not two.
    const substitute = stepsFromIds(CANDIDATE_POOL[purpose])
      .filter((s) => s.providerId !== legacy.providerId)
      .filter((s) =>
        isUsableFor(s.catalogId, Date.now(), purposeTier(purpose), {
          ignorePacing: true,
          purpose
        })
      )[0]
    return substitute ? [{ ...substitute, fromImplicitTail: true }] : [legacy]
  }

  // Never re-issue the identical request as a later "fallback". The dedupe in
  // completeWithFallback works on catalogId, and a synthetic `legacy:<id>` can
  // never match a real catalog id — so without this, a single-key user's
  // attempt 1 and attempt 3 were literally the same call (six of eight
  // providers' default model IS a catalog entry's modelId — see
  // ProviderRegistryEntry.defaultModelId).
  const legacyModelId = PROVIDER_REGISTRY[legacy.providerId].defaultModelId
  // BUG-154 (2026-09-01) — the dedupe must match on PROVIDER AND MODEL, not
  // on model alone.
  //
  // The intent is right: never re-issue the identical request as a later
  // "fallback". But identical means same provider AND same model. Several
  // catalog entries are deliberately DUAL-HOMED -- the same open-weights model
  // served by two different companies -- and model-catalog.ts says so outright:
  // "Two entries can share a modelId+displayName on different providers (the
  // dual-homed GPT-OSS 120B)".
  //
  // Matching on modelId alone therefore deleted a genuinely different provider,
  // with its own account, endpoint and quota, from the chain. Concretely: Groq's
  // legacy default model is openai/gpt-oss-120b, so cerebras-gpt-oss-120b was
  // dropped from EVERY durable chain for any user whose default provider is
  // Groq -- a configured, paid-for, perfectly healthy key that could never be
  // reached. That is precisely the founder's report: "it needs to eventually
  // try ALL the saved keys and APIs in the system if one fails FOR WHATEVER
  // REASON." It never tried Cerebras at all.
  //
  // Found by bug154-eventually-tries-every-key.test.ts, which loops resolve-
  // and-fail and names the providers that hold a key and were never attempted.
  // BUG-159 — the tail draws from the UNCAPPED pool.
  //
  // bundledSteps() applies CHAIN_BUDGET's maxChainLength, which for the live
  // purposes is 2 — so a tail built from it could only ever reach the first two
  // live entries of SPEED_CHAIN, and the founder's paid Anthropic key (further
  // down the lane) was unreachable however often the ones ahead failed. Caught
  // by bug154-eventually-tries-every-key: "never attempted despite holding a
  // key: anthropic, huggingface".
  //
  // CANDIDATE_POOL is the same list without the ATTEMPTS cap, and its own doc
  // comment already draws the distinction this fix rests on: the cap answers
  // "how many attempts may this purpose make", which is a different question
  // from "which models are eligible". The attempts cap is still enforced — by
  // tailMax just below, and by the walk's own budget — so this widens
  // eligibility, never cost.
  const usable = stepsFromIds(CANDIDATE_POOL[purpose]).filter(
    (s) =>
      legacyModelId === undefined ||
      s.providerId !== legacy.providerId ||
      s.modelId !== legacyModelId
  )

  // Different providers FIRST, then at most ONE same-provider model.
  // Dropping same-provider entries entirely would leave memory-extract
  // (whose bundled chain is groq+cerebras only) with nothing behind a groq
  // legacy step; leaving them in order would make the first "fallback" behind
  // a google legacy step be google-gemini-flash — the account that just 429'd.
  // One is kept because Groq and Gemini rate-limit PER-MODEL, so a different
  // model on the same key genuinely can succeed; only one, because if two
  // models on that key fail, the account is the problem, not the model.
  // BUG-159 — the capped tail SLOTS go to steps that can actually be
  // attempted, while every other step stays in the chain behind them.
  //
  // THE PROBLEM: a benched model held one of the 1-3 slots forever. The walk
  // skips it at attempt time, so it never fails again in a way that would move
  // it, and a usable model further down never entered the chain at all.
  // Measured with four keys configured: coaching-cue "never attempted despite
  // holding a key: anthropic, huggingface".
  //
  // WHY NOT SIMPLY FILTER THEM OUT, which is what three earlier attempts did:
  // the walk ALREADY filters this chain by its own usability gate before
  // attempting anything, so dropping them here buys nothing for attempts — and
  // it strips them from `capable`, which two other consumers read:
  //   * soonestExpiry(capable.map(...)) computes the ACTIONABLE WAIT TIME
  //     ("try again in about an hour"). Without the cooling entries there is
  //     nothing to compute it from, and the user gets the generic "every
  //     configured model is unreachable" that M27 D records reaching a real
  //     user once already.
  //   * rescueSteps(capable, ...) needs the full picture to offer a
  //     never-tried key.
  //
  // So: PARTITION, do not filter. Attemptable steps compete for the capped
  // slots; the rest are appended behind them, where the walk will skip them
  // and the other consumers can still see them. Attempt count is unchanged —
  // it was always bounded by the walk's own gate and budget, never by this
  // array's length.
  const attemptableNow = (step: ResolvedStep): boolean =>
    isUsableFor(step.catalogId, Date.now(), purposeTier(purpose), {
      ignorePacing: true,
      purpose
    })
  const ready = usable.filter(attemptableNow)
  const notReady = usable.filter((s) => !attemptableNow(s))
  const readyOthers = ready.filter((s) => s.providerId !== legacy.providerId)
  const readySame = ready.filter((s) => s.providerId === legacy.providerId).slice(0, 1)
  const tail = [...[...readyOthers, ...readySame].slice(0, tailMax), ...notReady].map((s) => ({
    ...s,
    fromImplicitTail: true
  }))

  // BUG-148 — a provider that keeps rejecting our credential gives up its
  // place at the FRONT, and nothing else. Same steps, same length, same cost:
  // only the order changes, so the worst case is exactly today's behaviour.
  //
  // It stays in the chain ON PURPOSE. Removing it is what creates the trap the
  // founder named — "nothing ever retries a demoted provider" — because a step
  // that is never attempted can never produce the success that would clear it.
  // At the back it is still reached whenever everything ahead fails, which is
  // exactly when we would want to try it anyway.
  //
  // If the tail is empty there is nothing to demote behind, and [legacy] is
  // returned unchanged rather than an empty chain.
  // BUG-159 — an UNUSABLE default gives up the front too, not only an
  // auth-demoted one.
  //
  // The substitution BUG-154 added for the live purposes lived inside the
  // `tailMax === 0` branch above. Raising LEGACY_TAIL_MAX to 1 skips that
  // branch entirely, so without this an exhausted, cooling or structurally-
  // broken default would silently lead the chain again.
  //
  // Demotion stays PROVIDER-scoped (an auth rejection condemns the key) while
  // usability is STEP-scoped (a cooldown condemns one model), so both are
  // consulted rather than one derived from the other.
  //
  // Reordered, never removed: the default stays in the chain so it can still
  // earn its place back with a success — a step never attempted can never
  // produce the evidence that would restore it.
  const legacyLeads =
    !legacyDemoted &&
    isUsableFor(legacy.catalogId, Date.now(), purposeTier(purpose), {
      ignorePacing: true,
      purpose
    })
  if (!legacyLeads && tail.length > 0) return [...tail, legacy]
  return [legacy, ...tail]
}

/** BUG-057 Phase 6 — resolveConfiguredChain() unchanged, plus an optional
 *  tool-calling capability filter. `capable` equals `configured` when
 *  `needsTool` is false/omitted, so every existing caller that never passes
 *  `opts` sees identical behavior to before this phase. */
/**
 * BUG-057 Phase 5 — CHAIN_BUDGET is exactly the two live, latency-critical
 * purposes (coaching-cue, deal-tier1); everything else is 'durable'. See
 * model-cooldown.ts's CooldownTier doc comment for what this drives.
 *
 * M27 — exported and made the SINGLE definition. It was previously inlined
 * identically at both fallback walks, and ai/capacity.ts now needs the same
 * answer to decide whether a background job's chain has anything usable. A
 * third hand-copy of `purpose in CHAIN_BUDGET` is exactly the shape that let
 * DealIntelligenceStatus drift into two declarations with only one fixed.
 */
/**
 * M27 — a wait, said the way a person says it.
 *
 * This message is read by a rep in the middle of their working day, and it
 * used to render as "Try again in about 3578s." Nobody converts that in their
 * head; it reads as a machine talking to itself, and it hides the one fact
 * that matters (it's an hour, so go and do something else).
 *
 * Deliberately vague at the top end. The underlying number is a CHOSEN
 * default (PERIOD_EXHAUSTED_DEFAULT_MS), not a provider-stated reset time, so
 * "about an hour" is exactly as precise as the data actually is — and
 * "3578s" implied a precision that never existed.
 */
export function humanWait(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000))
  // A cooldown that expired between the check and the message renders as
  // "in a moment" rather than "about 1 seconds" — which is both ungrammatical
  // and reads as broken rather than ready.
  if (secs <= 2) return 'a moment'
  if (secs < 90) return `about ${secs} seconds`
  const mins = Math.round(secs / 60)
  if (mins < 45) return `about ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  if (hours <= 1) return 'about an hour'
  if (hours < 24) return `about ${hours} hours`
  return 'about a day'
}

export function purposeTier(purpose: AIPurpose): CooldownTier {
  return purpose in CHAIN_BUDGET ? 'live' : 'durable'
}

/** M28 Part 3 — which LEGACY steps (providers with no catalog entries, so no
 *  per-entry flag) can read images. Hand-verified 2026-08-21: every current
 *  Claude and GPT chat model accepts image input; Gemini is catalog-flagged. */
const VISION_CAPABLE_LEGACY_PROVIDERS: ReadonlySet<CatalogEntry['providerId']> = new Set([
  'anthropic',
  'openai',
  'google'
])

export function stepSupportsVision(step: ResolvedStep): boolean {
  const entry = catalogEntry(step.catalogId)
  if (entry) return entry.supportsVision === true
  return step.catalogId.startsWith('legacy:') && VISION_CAPABLE_LEGACY_PROVIDERS.has(step.providerId)
}

/** AUDIT FIX (2026-08-24) — the document equivalent of the vision set.
 *  Anthropic, OpenAI and Google each have an adapter that builds a real
 *  document part for their own API (anthropic.ts:146, openai.ts:112,
 *  gemini.ts:108). Every other provider is served by openai-compatible.ts,
 *  which sends OpenAI's file format to APIs that do not implement it. */
const DOCUMENT_CAPABLE_LEGACY_PROVIDERS: ReadonlySet<CatalogEntry['providerId']> = new Set([
  'anthropic',
  'openai',
  'google'
])

export function stepSupportsDocuments(step: ResolvedStep): boolean {
  const entry = catalogEntry(step.catalogId)
  if (entry) return entry.supportsDocuments === true
  return (
    step.catalogId.startsWith('legacy:') &&
    DOCUMENT_CAPABLE_LEGACY_PROVIDERS.has(step.providerId)
  )
}

import type { ChainCapabilityNeeds } from './capability-needs'
import { noCapableModelMessage } from './capability-copy'
export type { ChainCapabilityNeeds }
export { noCapableModelMessage }

/**
 * BUG-125 (2026-08-27) — capability fallbacks: every KEYED provider that can
 * do the thing, not just the one that happens to be "active".
 *
 * THE FIELD FAILURE THIS FIXES. The founder attached an image in Rise on a
 * machine with ChatGPT, Groq, OpenRouter and Gemini all configured — and got
 * "Every configured model failed to respond". The per-model breakdown showed
 * exactly ONE attempt: `google-gemini-flash — TimeoutError`. A paid OpenAI
 * key sat unused.
 *
 * Why one attempt, on a nine-entry chain: assistant-chat uses QUALITY_CHAIN,
 * and of its nine catalog entries exactly ONE is vision-capable
 * (google-gemini-flash — groq-llama-4-scout is vision-capable but is not in
 * this chain). So the vision filter collapses a nine-model chain to one. The
 * legacy step would normally backstop that, but it is built from
 * getActiveAIProvider() ALONE, and the active provider was not one of the
 * three vision-capable legacy providers — so it was filtered out too.
 *
 * The result is a single point of failure that LOOKS like a deep fallback
 * chain: OpenAI and Anthropic have no catalog entries at all (see
 * model-catalog.ts's supportsVision comment), so they are reachable ONLY as
 * the legacy step — which means a user's paid vision-capable key is
 * unreachable for vision unless that provider also happens to be their
 * active one. Nothing in the UI suggests that coupling exists.
 *
 * So: when a capability was REQUIRED and therefore filtered the chain, offer
 * a legacy step for every other keyed provider that supports it. Appended
 * LAST, deliberately — the bundled free-tier chain still goes first, which
 * preserves this file's cost posture; these only run when it has failed.
 *
 * Scoped to capability-gated requests on purpose: this must not silently
 * widen ordinary text turns, which already have a deep chain and an explicit
 * legacy-tail policy (LEGACY_TAIL_MAX).
 */
function capabilityFallbackSteps(
  needs: ChainCapabilityNeeds,
  already: ResolvedStep[]
): ResolvedStep[] {
  if (!needs.needsVision && !needs.needsDocument) return []
  const out: ResolvedStep[] = []
  for (const [providerId] of Object.entries(PROVIDER_REGISTRY)) {
    if (!providerHasCredentials(providerId as AIProviderId)) continue
    const step: ResolvedStep = {
      catalogId: `legacy:${providerId}`,
      providerId: providerId as ResolvedStep['providerId'],
      modelId: ''
    }
    // Skip a provider ALREADY represented in the chain — by providerId, not
    // just catalogId. A legacy step behind that provider's own catalog entry
    // is the same key and (usually) the same model: the identical request
    // re-issued as a "fallback", which this file already refuses to do for
    // the legacy tail. It is also what the existing vision tests assert, and
    // they caught this when the first version of the fix over-reached.
    if (already.some((s) => s.providerId === step.providerId)) continue
    if (needs.needsVision && !stepSupportsVision(step)) continue
    if (needs.needsDocument && !stepSupportsDocuments(step)) continue
    out.push(step)
  }
  return out
}

/**
 * BUG-125b (2026-08-28) — the LAST-RESORT rescue that makes "add another
 * provider key" true.
 *
 * THE FIELD FAILURE. After the capability fix, the founder hit a different
 * wall on a second machine: "Every model set up for this is rate-limited right
 * now. Try again in about an hour." — with a brand-new PAID Claude key just
 * added. That message is the PRE-WALK refusal: every entry in the resolved
 * chain was cooling down, so nothing was attempted at all (which is also why
 * there was no per-model breakdown to read).
 *
 * Why the new key did not help: Anthropic and OpenAI have NO catalog entries
 * (see model-catalog.ts), so they enter a chain only as the legacy step —
 * which is built from getActiveAIProvider() ALONE. A freshly-added key for a
 * provider that is not the active one is therefore invisible to the chain, no
 * matter how much credit is on it. The error told the user to do the one
 * thing that could not work, which is worse than saying nothing.
 *
 * So: when the chain is entirely unusable, before refusing, offer any KEYED
 * provider that is not already represented and is not itself cooling down. A
 * provider that has never been tried cannot be rate-limited, so this is
 * precisely the case the refusal was wrong about.
 *
 * Deliberately LAST-RESORT, not part of the normal chain: it runs only when
 * the answer would otherwise be "no", so it cannot change ordinary routing,
 * ordering, or this file's free-tier-first cost posture. It also cannot
 * bypass a cooldown — every candidate is passed through the same isUsableFor
 * gate as everything else.
 */
function rescueSteps(
  already: ResolvedStep[],
  now: number,
  tier: CooldownTier,
  purpose: AIPurpose
): ResolvedStep[] {
  // DURABLE CALLERS ONLY, and this is a correctness boundary rather than a
  // preference. The live tier (coaching-cue, deal-tier1) has a single-digit-
  // second budget and a deliberately thin chain, and BUG-058's entire point is
  // that when those models are cooling mid-call the right move is to STOP —
  // not to spend another round trip on a cold provider. Rescuing a live caller
  // would defeat that, and modelCooldown.test.ts asserts it must not ("a live
  // caller does NOT bypass its own cooldown"). The founder's case is a human
  // typing in Rise, which is durable.
  if (tier !== 'durable') return []
  const out: ResolvedStep[] = []
  for (const [providerId] of Object.entries(PROVIDER_REGISTRY)) {
    if (!providerHasCredentials(providerId as AIProviderId)) continue
    if (already.some((s) => s.providerId === providerId)) continue
    const step: ResolvedStep = {
      catalogId: `legacy:${providerId}`,
      providerId: providerId as ResolvedStep['providerId'],
      modelId: ''
    }
    if (!isUsableFor(step.catalogId, now, tier, { purpose })) continue
    out.push(step)
  }
  return out
}

/**
 * BUG-142 (2026-08-30) — the same rescue, reachable at the END of an exhausted
 * walk rather than only before one starts.
 *
 * THE FIELD FAILURE. The founder pasted a Cloudflare token Cloudflare rejects.
 * Post-call summaries stopped entirely — "Every configured key was rejected" —
 * while a known-good Hugging Face key sat connected on the same account.
 * Fifteen identical `legacy:cloudflare -> null` events, no fall-through.
 *
 * WHY THE PRE-WALK RESCUE COULD NOT HELP. `rescueSteps` above is offered only
 * when `chain.length === 0` BEFORE the walk. That gate opens only if something
 * PERSISTED a reason to exclude every step — a cooldown, or a structural
 * break. An `auth` failure persists neither: `deadProviders` is declared
 * inside the walk and dies with it, and `markStructurallyBroken` explicitly
 * skips `auth` ("already gets a coarser, PROVIDER-wide skip"). So a bad key
 * leaves its legacy step looking perfectly usable at the start of every walk,
 * `chain.length` is 1 rather than 0, and the rescue never fires — identically,
 * forever.
 *
 * THE INVERSION THAT PRODUCES, and it is why this is a design fix rather than
 * a patch: **a rescue gated on emptiness rescues TRANSIENT failures and
 * abandons PERMANENT ones.** A rate limit persists a cooldown, so the next
 * walk starts empty and IS rescued. A wrong key persists nothing, so it never
 * is. The more permanent the failure — the more the user actually needs their
 * other key — the less likely they are to get it. Nobody would design that; it
 * falls out of gating on a pre-walk snapshot.
 *
 * BUG-125b's own stated intent is satisfied by this version and only
 * accidentally by the old one: "it runs only when the answer would otherwise
 * be no". The end of an exhausted walk is precisely, and only, that moment.
 *
 * Everything that made the pre-walk rescue safe still holds — durable tier
 * only, every candidate through the same `isUsableFor` gate, never a provider
 * already represented in the chain. Two further exclusions apply here and
 * cannot be dropped: a step already ATTEMPTED this walk (re-issuing an
 * identical failed request is the one thing this file refuses to do), and a
 * provider in `deadProviders` (its key was just rejected — a second model on
 * the same dead key is a guaranteed-doomed request).
 *
 * ── THE BOUND, AND WHY IT IS NOT A DETAIL ────────────────────────────────
 *
 * The first version of this returned EVERY eligible keyed provider, and that
 * rebuilt BUG-058's spiral inside the fix for a different bug.
 *
 * The cost of a widening fallback scales with the user's CONFIGURATION, not
 * with the code. With one spare key an exhausted walk costs one extra request;
 * with five it costs five. And the moment this path runs most often is a total
 * outage — when every provider is down — so every walk would then spend N
 * doomed requests and push N sets of rate limits further out. That is exactly
 * the spiral BUG-058 exists to break, arrived at from the opposite direction.
 * M31 added three more providers, so N is growing.
 *
 * So the rescue is bounded to ONE additional provider: 1 -> 2, never 1 -> N.
 * That is enough to make "add another provider key in Settings" true advice,
 * which was BUG-125b's entire purpose, while keeping the cost of a total
 * outage flat instead of proportional to how well-configured the user is.
 *
 * Selection is registry order — deterministic and predictable rather than
 * clever. Every candidate has already passed `isUsableFor`, so none of them is
 * cooling, benched or paced; there is no evidence available here that would
 * make one a better bet than another. If a ranking is ever wanted (paid before
 * free, fastest observed, healthiest by purpose-health), it belongs in
 * `rescueSteps` with its own reasoning, not smuggled into a `.slice()`.
 */
const END_OF_WALK_RESCUE_MAX = 1

function endOfWalkRescue(
  chain: ResolvedStep[],
  attempted: Set<string>,
  deadProviders: Set<AIProviderId>,
  now: number,
  tier: CooldownTier,
  purpose: AIPurpose
): ResolvedStep[] {
  return rescueSteps(chain, now, tier, purpose)
    .filter((s) => !attempted.has(s.catalogId) && !deadProviders.has(s.providerId))
    .slice(0, END_OF_WALK_RESCUE_MAX)
}

export function resolveChain(purpose: AIPurpose, opts?: ChainCapabilityNeeds): ResolvedChain {
  const configured = resolveConfiguredChain(purpose)
  let capable = configured
  if (opts?.needsTool) {
    capable = capable.filter((s) => catalogEntry(s.catalogId)?.supportsToolCalling !== false)
  }
  if (opts?.needsVision) capable = capable.filter(stepSupportsVision)
  if (opts?.needsDocument) capable = capable.filter(stepSupportsDocuments)
  if (opts) capable = [...capable, ...capabilityFallbackSteps(opts, capable)]
  return { configured, capable }
}



// BUG-057 Phase 6 follow-up — the one deferred piece of that phase, closed.
// `supportsToolCalling: false` (model-catalog.ts) is a static, hand-verified
// flag with NO live re-check — unlike `knownStale`, which resolveCatalog()
// re-confirms every ~10 min, listModels() returns ID strings only, no
// capability data. Its own doc comment names the resulting staleness risk
// exactly: if a provider ships tool-calling support later, a `false` entry
// stays SILENTLY excluded from a needsTool chain — "no error and no log
// line... worse than a wasted attempt, which at least surfaces in
// fallback-log.ts." This closes precisely that gap: an exclusion is now
// logged to the SAME fallback-event surface every other fallback decision
// already uses (Settings → Model Assignment's recent-activity list), so a
// stale flag is diagnosable there instead of invisible. It does NOT change
// the filter's behavior — the model stays excluded (attempting it anyway
// would waste a request per call on the correct-flag case, and eat the live
// path's tight CHAIN_BUDGET); it only makes the already-correct exclusion
// visible.
//
// Deduplicated per (purpose, catalogId) per process: the exclusion is a
// static property of the catalog + needsTool, identical on every call, and
// coaching-cue re-resolves this every ~2.5s mid-call — logging it every time
// would both spam and evict real fallback history from fallback-log.ts's
// 1000-entry cap. Once per model per session makes it visible; a restart
// re-logs, which is correct — a process restart is exactly when a provider's
// support (and thus the flag's staleness) may have changed.
const loggedToolExclusions = new Set<string>()

function logToolCapabilityExclusions(
  purpose: AIPurpose,
  configured: ResolvedStep[],
  capable: ResolvedStep[]
): void {
  if (configured.length === capable.length) return // nothing was excluded
  const capableIds = new Set(capable.map((s) => s.catalogId))
  for (const step of configured) {
    if (capableIds.has(step.catalogId)) continue
    const key = `${purpose}:${step.catalogId}`
    if (loggedToolExclusions.has(key)) continue
    loggedToolExclusions.add(key)
    void logFallbackEvent({
      ts: new Date().toISOString(),
      purpose,
      fromCatalogId: step.catalogId,
      toCatalogId: null,
      reason: 'skipped: tool-calling not verified for this model',
      detail:
        'Excluded from a tool-calling request by the catalog flag supportsToolCalling:false. If this provider now supports forced tool calls, that flag is stale — see model-catalog.ts.'
    })
  }
}

/** Test-only — resets the once-per-session dedup set for logToolCapabilityExclusions. */
export function resetToolExclusionLogForTests(): void {
  loggedToolExclusions.clear()
}

/** BUG-058 Phase 2 — shared by both walks. Call once per rate-limit-classified
 *  failure (period-exhausted or plain); once the SAME provider has done this
 *  twice in one walk, on two different models (chain is deduped by catalogId,
 *  so a second count here is necessarily a different model), the rest of that
 *  provider's entries are added to deadProviders. See the doc comment on
 *  deadProviders itself for why this is scoped to same-walk, same-provider
 *  evidence only, not a cooldown-duration or classification change. */
function noteRateLimitForDeadProviders(
  providerId: AIProviderId,
  rateLimitCountByProvider: Map<AIProviderId, number>,
  deadProviders: Set<AIProviderId>
): void {
  const count = (rateLimitCountByProvider.get(providerId) ?? 0) + 1
  rateLimitCountByProvider.set(providerId, count)
  if (count >= 2) deadProviders.add(providerId)
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
  const needs: ChainCapabilityNeeds = {
    needsTool: Boolean(req.tool),
    needsVision: Boolean(req.images?.length),
    needsDocument: Boolean(req.document)
  }
  const { configured, capable } = resolveChain(purpose, needs)
  logToolCapabilityExclusions(purpose, configured, capable)
  const tier: CooldownTier = purposeTier(purpose)

  if (configured.length === 0) {
    void recordAiFailure(purpose, { reason: 'no-key', providerId: null })
    throw new AIProviderError('no-key', 'No AI provider is configured for this yet.')
  }
  if (capable.length === 0) {
    // BUG-057 Phase 6 — configured.length > 0 here by construction: real
    // keys ARE configured, none of them are verified to support the
    // capability this request needs (forced tool calls, or image input —
    // M28). Distinct from the no-key case above (and from the cooldown
    // case below) — a different problem with a different fix (reassign a
    // model in Settings, not add/wait for a key).
    void recordAiFailure(purpose, {
      reason: 'failed',
      providerId: null,
      detail: needs.needsVision
        ? 'no configured model verified to support image input'
        : 'no configured model verified to support tool calling'
    })
    throw new AIProviderError(
      'failed',
      noCapableModelMessage(needs),
      undefined,
      'structural'
    )
  }

  // BUG-058 — skip models that just rate-limited us. Filtered HERE rather
  // than inside resolveChain, so resolution stays a pure function of settings
  // + keys, and so the "everything is cooling down" case below can tell the
  // difference between "you have no keys" and "your keys need a minute".
  const startedNow = Date.now()
  let chain = capable.filter((s) => isUsableFor(s.catalogId, startedNow, tier, { purpose }))

  // BUG-125e — THE PACED TAIL. Verified by the agent audit and its adversarial
  // pass: EVERY single-key user self-paced to death on capability turns. One
  // Rise turn makes sequential assistant-chat calls (plan, then answer); the
  // plan's SUCCESS paces the provider for up to 6s, and for a single-key user
  // the answer's chain collapses to exactly that one step — so the turn's own
  // politeness mark starved its only candidate, and the walk refused.
  //
  // Pacing is self-imposed spacing (model-pacing.ts: "a model that is merely
  // paced genuinely has capacity"), so a paced-ONLY step — usable in every
  // other respect — stays in the chain, sorted LAST. The walk waits the
  // remaining gap out only if it actually REACHES one, i.e. only after every
  // un-paced candidate has been tried and failed. That preserves the
  // skip-not-wait divert behaviour pinned by modelPacing.test.ts (a walk with
  // somewhere to divert TO never sleeps) and converts only the formerly
  // refused dead-end into a bounded wait. Durable tier only: live callers are
  // never paced at all, and their budgets must never absorb a sleep.
  //
  // Known, accepted deviation from BUG-058 (recorded by the adversarial pass):
  // concurrent durable walks that all dead-end on the same paced step wake at
  // the same gap expiry and fire together. Bounded (one sleep, ≤6s), rare
  // (requires simultaneous fully-paced dead-ends), and strictly better than
  // all of them refusing.
  const pacedUntil = new Map<string, number>()
  if (tier === 'durable') {
    for (const s of capable) {
      if (chain.includes(s)) continue
      if (!isUsableFor(s.catalogId, startedNow, tier, { purpose, ignorePacing: true })) continue
      pacedUntil.set(s.catalogId, pacedUntilFor(s.catalogId, startedNow, tier) ?? startedNow)
    }
  }
  const pacedTail = capable.filter((s) => pacedUntil.has(s.catalogId))

  // BUG-125c — record WHY each excluded entry was excluded, for the error's
  // "not tried" section. Computed AFTER the paced tail on purpose: a paced
  // step WILL be tried now, so listing it under "not tried" would be a lie.
  const notTried = capable
    .filter((s) => !chain.includes(s) && !pacedUntil.has(s.catalogId))
    .map((s) => {
      // BUG-125d — name the EXACT gate. The first version lumped structural
      // breaks and pacing into one sentence, and the founder's report landed
      // on precisely that line: "structural break, OR paced too recently" is
      // two completely different bugs with two different fixes, and the
      // message could not say which. A diagnostic that stops one question
      // short of the answer is only most of a diagnostic.
      const until = cooldownUntil(s.catalogId, startedNow)
      if (until) {
        return {
          catalogId: s.catalogId,
          why: `cooling down for another ${humanWait(until - startedNow)}`
        }
      }
      if (isStructurallyBroken(s.catalogId, startedNow, purpose)) {
        const cause = structuralBreakReason(s.catalogId, purpose)
        return {
          catalogId: s.catalogId,
          why:
            'benched up to 4h by a STRUCTURAL BREAK' +
            (cause ? ` after rejecting an earlier request with: ${cause}` : '') +
            ' (restarting the app clears it)'
        }
      }
      if (isPacedFor(s.catalogId, startedNow, tier)) {
        return { catalogId: s.catalogId, why: 'PACED — used too recently, a few seconds apart' }
      }
      return { catalogId: s.catalogId, why: 'skipped by the usability gate for an unknown reason' }
    })
  // BUG-125b — everything cooling is exactly when a freshly-added key should
  // rescue the turn, and exactly when it previously could not. See rescueSteps.
  //
  // ORDERING (adversarial amendment): rescue steps go BEFORE the paced tail.
  // A freshly-added, never-tried key must be attempted immediately — with
  // zero sleep — rather than queueing behind a paced provider that just
  // failed. Without this, the paced tail would make the chain non-empty and
  // silently disable the rescue.
  if (chain.length === 0) {
    chain = [...rescueSteps(capable, startedNow, tier, purpose), ...pacedTail]
  } else {
    chain = [...chain, ...pacedTail]
  }

  if (chain.length === 0) {
    // Every model is in cooldown. Refusing here is the POINT: walking the
    // chain anyway spends a doomed request on each one and pushes their
    // limits out further, which is the spiral this fix exists to break.
    // Reported as a wait, with a number, rather than a generic failure.
    const until = soonestExpiry(
      capable.map((s) => s.catalogId),
      startedNow,
      tier,
      purpose
    )
    // BUG-125 audit — the 60 was FABRICATED: soonestExpiry reads only the
    // cooldown map, and a merely-paced model has no entry there, so a refusal
    // caused purely by pacing told the user to wait "about 60 seconds" for a
    // condition that clears in <=6. Use the real pacing remainder when no
    // cooldown expiry exists.
    const pacedSoonest = capable
      .map((s) => pacedUntilFor(s.catalogId, startedNow, tier))
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b)[0]
    const effectiveUntil = until ?? pacedSoonest ?? null
    const secs = effectiveUntil ? Math.max(1, Math.ceil((effectiveUntil - startedNow) / 1000)) : 60
    void recordAiFailure(purpose, { reason: 'rate-limit', providerId: null })
    throw new AIProviderError(
      'rate-limit',
      `Every model set up for this is rate-limited right now. Try again in ${humanWait(secs * 1000)}.`,
      effectiveUntil ? effectiveUntil - startedNow : undefined
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
  let lastAttempt: {
    reason: AIProviderErrorCode
    providerId: AIProviderId
    detail?: string
    // BUG-058 Phase 3 — carried through to recordAiFailure below so
    // purpose-health.ts's messageFor() can distinguish an ordinary rate
    // limit from a genuine quota exhaustion, and show a real reset time
    // when one exists.
    failureClass?: AIFailureClass
    resetsAt?: number
  } | null = null
  const attempted = new Set<string>() // defense-in-depth: chain is already deduped by construction
  // BUG-057 — an invalid or revoked key fails IDENTICALLY on every model that
  // provider offers, so once one step returns 'auth', every remaining step on
  // the same provider is a guaranteed-doomed request. Skipping them is what
  // keeps the new fallback tail from being "just slower failure" for a
  // single-key user with a bad key. Deliberately NOT extended to
  // 'rate-limit': Groq and Gemini rate-limit per-MODEL, so a different model
  // on the same key really can succeed.
  //
  // BUG-058 Phase 2 — extended to 'rate-limit' too, but only after a SECOND,
  // different model on the same provider also comes back rate-limited within
  // THIS walk (rateLimitCountByProvider below). One rate-limited model still
  // proves nothing about its neighbors (that's why the rule above stays
  // narrow) — but two different models on the same provider both refusing
  // within seconds of each other, in the same call, is stronger evidence
  // than either alone: the account is the likelier shared cause at that
  // point, not either individual model. Doesn't touch markRateLimited or its
  // cooldown duration — this only skips a third doomed attempt within an
  // already-doomed walk, layered on top of per-model cooldown, not replacing
  // it.
  const deadProviders = new Set<AIProviderId>()
  // BUG-148 — de-duplicates auth rejections WITHIN this walk; see noteAuthRejection.
  const authNotedThisWalk = new Set<AIProviderId>()
  const rateLimitCountByProvider = new Map<AIProviderId, number>()

  // BUG-059 — one hard wall-clock ceiling across the ENTIRE walk, including
  // each SDK's own internal retries (the signal below is threaded all the way
  // into the SDK call, so aborting it cuts a retry loop mid-flight). Without
  // this, our chain bound and the SDK's retry bound multiply unbounded: up to
  // ~27 minutes for one summary, with no way to cancel out of it.
  const ceiling = new AbortController()
  const ceilingTimer = setTimeout(() => ceiling.abort(), HARD_CEILING_MS[purpose])

  // BUG-125e — waits out a paced step's remaining gap, bounded and abortable.
  // Only ever reached for a paced-tail step (see pacedUntil above). The sleep
  // is capped at one full gap, runs under the SAME combined signal as the
  // attempts themselves (ceiling + caller Stop), and is logged so the wait is
  // visible in Settings' recent-activity list rather than reading as dead air.
  const waitOutPacingIfNeeded = async (step: ResolvedStep): Promise<void> => {
    const until = pacedUntil.get(step.catalogId)
    if (until === undefined) return
    const waitMs = Math.min(Math.max(0, until - Date.now()), PACING_GAP_MS)
    if (waitMs <= 0) return
    void logFallbackEvent({
      ts: new Date().toISOString(),
      purpose,
      fromCatalogId: step.catalogId,
      toCatalogId: step.catalogId,
      reason: 'paced-wait',
      detail: `Last-resort step is pacing-blocked; waiting ${waitMs}ms out instead of refusing (BUG-125).`
    })
    const parts: AbortSignal[] = [ceiling.signal]
    if (req.signal) parts.push(req.signal)
    await abortableSleep(waitMs, parts.length === 1 ? parts[0] : AbortSignal.any(parts))
  }

  try {
  // BUG-142 — TWO PASSES, and the loop body below is deliberately untouched.
  // Pass 0 is the walk exactly as it always was. If it exhausts without an
  // answer, pass 1 re-enters over a chain extended with endOfWalkRescue()'s
  // one candidate. Re-entering is free: the inner loop already skips anything
  // in `attempted`, so every step from pass 0 is passed over without a request.
  //
  // Written as an outer loop rather than a second copy of the attempt logic on
  // purpose — the alternative was duplicating ~150 lines of pacing, cooldown,
  // budget and ceiling handling, which is how two paths drift apart.
  for (let pass = 0; pass < 2; pass++) {
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]
    if (ceiling.signal.aborted) break
    if (attempted.has(step.catalogId)) continue
    attempted.add(step.catalogId)
    if (deadProviders.has(step.providerId)) continue

    const key = process.env[PROVIDER_REGISTRY[step.providerId].keyEnvName]?.trim()
    // resolved eagerly above, but env could change mid-loop in theory
    if (!key || !providerHasCredentials(step.providerId)) continue
    await waitOutPacingIfNeeded(step)
    if (req.signal?.aborted) throw new Error('aborted by caller during paced wait')
    if (ceiling.signal.aborted) break
    if (
      pacedUntil.has(step.catalogId) &&
      !isUsableFor(step.catalogId, Date.now(), tier, { purpose, ignorePacing: true })
    ) {
      // A cooldown or structural break that arrived DURING the sleep is real
      // evidence — skip. A fresh pacing re-mark is deliberately ignored after
      // the one bounded wait, so a stranger's use cannot starve this walk.
      continue
    }
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
      clearCooldown(step.catalogId, purpose)
      // BUG-148 — and proof the credential works. A demoted provider is
      // still ATTEMPTED (it moved to the back of the chain, it was not
      // removed), so this line stays reachable for one, and reaching it is
      // exactly the evidence that should restore it. That reachability is
      // the whole reason demotion reorders instead of removing.
      clearDemotion(step.providerId)
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
      const resetsAt = err instanceof AIProviderError ? err.resetsAt : undefined
      lastAttempt = { reason: reason as AIProviderErrorCode, providerId: step.providerId, detail, failureClass, resetsAt }
      if (reason === 'auth') {
        deadProviders.add(step.providerId)
        // BUG-148 — the rejection is now REMEMBERED, not merely survived.
        // authNotedThisWalk holds one walk to at most one rejection per
        // provider: a walk can attempt the same key twice (a legacy step plus
        // a bundled entry on the same provider), and counting those separately
        // would demote on the strength of ONE call — the one-strike option
        // that was deliberately not chosen.
        if (!authNotedThisWalk.has(step.providerId)) {
          authNotedThisWalk.add(step.providerId)
          noteAuthRejection(step.providerId, Date.now())
        }
      }
      // BUG-058 — honour the provider's own "come back in N seconds" so the
      // next call skips this model instead of re-burning it. Without this,
      // every subsequent call restarted at position 1 and hit the same 429.
      // BUG-057 Phase 2 — a period-exhausted failure (quota/billing, not an
      // ordinary throttle) gets the longer period-exhausted default instead
      // of the ordinary 60s guess; retrying inside a quota window is pure
      // waste, not just impolite.
      //
      // M27 B3 — gated on failureClass ALONE, not `reason === 'rate-limit'
      // && failureClass === 'period-exhausted'` as this used to read. That
      // extra reason check was written to keep an ordinary structural/generic
      // error from cooling a model down on no real evidence — a reasonable
      // goal, but it happened to also exclude the one case failureClass was
      // built to catch: openai-compatible.ts's toProviderError() already
      // hardcodes failureClass:'period-exhausted' on its "out of quota/
      // credits" branch, but that branch's `reason` is 'failed', not
      // 'rate-limit' (Groq/OpenAI-compatible providers don't send a 429 for
      // this — it's a plain error whose MESSAGE says quota, not its status
      // code). The old condition threw that classification away right after
      // computing it: 14% of this app's own real fallback-log events were
      // exactly this shape, and every one got zero cooldown, retried on the
      // very next call. failureClass is already the richer, correctly-
      // derived signal (see failure-class.ts's classifyFailureClass) — reason
      // is still recorded below for logging, it just shouldn't re-gate a
      // conclusion failureClass already reached.
      if (failureClass === 'period-exhausted') {
        markPeriodExhausted(
          step.catalogId,
          err instanceof AIProviderError ? err.retryAfterMs : undefined,
          Date.now(),
          tier,
          resetsAt
        )
        // BUG-058 remainder — pacing marks alongside cooldown, on the same
        // period-exhausted classification as the branch above (never on a
        // plain transient 'failed' with no real capacity signal at all).
        markUsed(step.catalogId, Date.now(), tier)
        noteRateLimitForDeadProviders(step.providerId, rateLimitCountByProvider, deadProviders)
      } else if (reason === 'rate-limit') {
        markRateLimited(
          step.catalogId,
          err instanceof AIProviderError ? err.retryAfterMs : undefined,
          Date.now(),
          tier
        )
        markUsed(step.catalogId, Date.now(), tier)
        noteRateLimitForDeadProviders(step.providerId, rateLimitCountByProvider, deadProviders)
      } else if (failureClass === 'structural' && reason !== 'auth') {
        // 'auth' already gets a coarser, PROVIDER-wide skip (deadProviders,
        // above) — checking the raw reason string here, not re-deriving from
        // failureClass (which would also say 'structural' for auth), avoids
        // two independent encodings of the same exclusion drifting apart.
        markStructurallyBroken(step.catalogId, Date.now(), purpose, detail ? `${reason}: ${detail}` : reason)
      } else if (failureClass === 'transient' && reason !== 'auth') {
        // BUG-154 follow-up — repetition IS the evidence.
        //
        // A transient class means "this might work next time", and for a
        // sampling-dependent malformed generation that is true. It stops being
        // true after the third identical failure with no success in between,
        // and until this branch existed nothing counted them: Groq's
        // tool_use_failed is deliberately transient (openai-compatible.ts), so
        // live cues retried the same model every ~7s indefinitely and showed
        // the user nothing. Measured at twelve consecutive failures across two
        // real calls before this was added.
        //
        // noteTransientFailure escalates to a purpose-scoped structural break
        // at its threshold and returns whether IT did, so the escalation is
        // logged rather than being a silent state change. Any success clears
        // the streak (clearCooldown), so a model that recovers is asked again
        // at once instead of serving out the break.
        // The escalation is self-describing without a logger: the reason string
        // passed to markStructurallyBroken surfaces verbatim in the exhaustion
        // report the user actually reads ("benched up to 4h by a STRUCTURAL
        // BREAK after..."), which is this file's existing convention — it
        // imports no logger on purpose.
        void noteTransientFailure(step.catalogId, Date.now(), purpose)
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
  if (pass === 0) {
    // Out of time is not out of options — a ceiling abort must not spend a
    // fresh request; the caller is told about the timeout instead.
    if (ceiling.signal.aborted) break
    const extra = endOfWalkRescue(chain, attempted, deadProviders, Date.now(), tier, purpose)
    if (extra.length === 0) break
    void logFallbackEvent({
      ts: new Date().toISOString(),
      purpose,
      fromCatalogId: lastAttempt
        ? `legacy:${lastAttempt.providerId}`
        : (chain[chain.length - 1]?.catalogId ?? 'chain-exhausted'),
      toCatalogId: extra[0].catalogId,
      reason: 'rescue',
      detail:
        `Chain exhausted; offering ${extra.length} keyed provider not yet tried ` +
        `(BUG-142). This is the fall-through a rejected key used to block.`
    })
    chain = [...chain, ...extra]
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
    detail: lastAttempt?.detail,
    // BUG-058 Phase 3 — the last attempt's own classification/reset time,
    // for messageFor()'s period-exhausted branch.
    failureClass: lastAttempt?.failureClass,
    resetsAt: lastAttempt?.resetsAt
  })
  throw new AllModelsExhaustedError(purpose, attempts, notTried)
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
  const needs: ChainCapabilityNeeds = {
    needsTool: Boolean(req.tool),
    needsVision: Boolean(req.images?.length),
    needsDocument: Boolean(req.document)
  }
  const { configured, capable } = resolveChain(purpose, needs)
  logToolCapabilityExclusions(purpose, configured, capable)
  // coaching-chat (the only consumer today) isn't in CHAIN_BUDGET, so this is
  // always 'durable' currently; asked rather than hardcoded, so a future live
  // streaming consumer gets the right tier automatically.
  const tier: CooldownTier = purposeTier(purpose)
  // BUG-058 — same cooldown filter as completeWithFallback: a model that just
  // 429'd must not be re-burned here either. coaching-chat is the only
  // consumer, and it is interactive, so spending its first attempt on a model
  // we already know is limited is the most visible possible version of this.
  const startedNow = Date.now()
  let chain = capable.filter((s) => isUsableFor(s.catalogId, startedNow, tier, { purpose }))

  // BUG-125e — THE PACED TAIL. Verified by the agent audit and its adversarial
  // pass: EVERY single-key user self-paced to death on capability turns. One
  // Rise turn makes sequential assistant-chat calls (plan, then answer); the
  // plan's SUCCESS paces the provider for up to 6s, and for a single-key user
  // the answer's chain collapses to exactly that one step — so the turn's own
  // politeness mark starved its only candidate, and the walk refused.
  //
  // Pacing is self-imposed spacing (model-pacing.ts: "a model that is merely
  // paced genuinely has capacity"), so a paced-ONLY step — usable in every
  // other respect — stays in the chain, sorted LAST. The walk waits the
  // remaining gap out only if it actually REACHES one, i.e. only after every
  // un-paced candidate has been tried and failed. That preserves the
  // skip-not-wait divert behaviour pinned by modelPacing.test.ts (a walk with
  // somewhere to divert TO never sleeps) and converts only the formerly
  // refused dead-end into a bounded wait. Durable tier only: live callers are
  // never paced at all, and their budgets must never absorb a sleep.
  //
  // Known, accepted deviation from BUG-058 (recorded by the adversarial pass):
  // concurrent durable walks that all dead-end on the same paced step wake at
  // the same gap expiry and fire together. Bounded (one sleep, ≤6s), rare
  // (requires simultaneous fully-paced dead-ends), and strictly better than
  // all of them refusing.
  const pacedUntil = new Map<string, number>()
  if (tier === 'durable') {
    for (const s of capable) {
      if (chain.includes(s)) continue
      if (!isUsableFor(s.catalogId, startedNow, tier, { purpose, ignorePacing: true })) continue
      pacedUntil.set(s.catalogId, pacedUntilFor(s.catalogId, startedNow, tier) ?? startedNow)
    }
  }
  const pacedTail = capable.filter((s) => pacedUntil.has(s.catalogId))

  // BUG-125c — record WHY each excluded entry was excluded, for the error's
  // "not tried" section. Computed AFTER the paced tail on purpose: a paced
  // step WILL be tried now, so listing it under "not tried" would be a lie.
  const notTried = capable
    .filter((s) => !chain.includes(s) && !pacedUntil.has(s.catalogId))
    .map((s) => {
      // BUG-125d — name the EXACT gate. The first version lumped structural
      // breaks and pacing into one sentence, and the founder's report landed
      // on precisely that line: "structural break, OR paced too recently" is
      // two completely different bugs with two different fixes, and the
      // message could not say which. A diagnostic that stops one question
      // short of the answer is only most of a diagnostic.
      const until = cooldownUntil(s.catalogId, startedNow)
      if (until) {
        return {
          catalogId: s.catalogId,
          why: `cooling down for another ${humanWait(until - startedNow)}`
        }
      }
      if (isStructurallyBroken(s.catalogId, startedNow, purpose)) {
        const cause = structuralBreakReason(s.catalogId, purpose)
        return {
          catalogId: s.catalogId,
          why:
            'benched up to 4h by a STRUCTURAL BREAK' +
            (cause ? ` after rejecting an earlier request with: ${cause}` : '') +
            ' (restarting the app clears it)'
        }
      }
      if (isPacedFor(s.catalogId, startedNow, tier)) {
        return { catalogId: s.catalogId, why: 'PACED — used too recently, a few seconds apart' }
      }
      return { catalogId: s.catalogId, why: 'skipped by the usability gate for an unknown reason' }
    })
  // BUG-125b — everything cooling is exactly when a freshly-added key should
  // rescue the turn, and exactly when it previously could not. See rescueSteps.
  //
  // ORDERING (adversarial amendment): rescue steps go BEFORE the paced tail.
  // A freshly-added, never-tried key must be attempted immediately — with
  // zero sleep — rather than queueing behind a paced provider that just
  // failed. Without this, the paced tail would make the chain non-empty and
  // silently disable the rescue.
  if (chain.length === 0) {
    chain = [...rescueSteps(capable, startedNow, tier, purpose), ...pacedTail]
  } else {
    chain = [...chain, ...pacedTail]
  }

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
      // keys ARE configured, none of them are verified to support the needed
      // capability (tool calls, or image input — M28). Distinct from the
      // no-key case above and the cooldown case below — same three-way
      // split as completeWithFallback.
      void recordAiFailure(purpose, {
        reason: 'failed',
        providerId: null,
        detail: needs.needsVision
          ? 'no configured model verified to support image input'
          : 'no configured model verified to support tool calling'
      })
      const err = new AIProviderError(
        'failed',
        noCapableModelMessage(needs),
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
        tier,
        purpose
      )
      // BUG-125 audit — the 60 was FABRICATED: soonestExpiry reads only the
    // cooldown map, and a merely-paced model has no entry there, so a refusal
    // caused purely by pacing told the user to wait "about 60 seconds" for a
    // condition that clears in <=6. Use the real pacing remainder when no
    // cooldown expiry exists.
    const pacedSoonest = capable
      .map((s) => pacedUntilFor(s.catalogId, startedNow, tier))
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b)[0]
    const effectiveUntil = until ?? pacedSoonest ?? null
    const secs = effectiveUntil ? Math.max(1, Math.ceil((effectiveUntil - startedNow) / 1000)) : 60
      void recordAiFailure(purpose, { reason: 'rate-limit', providerId: null })
      const err = new AIProviderError(
        'rate-limit',
        `Every model set up for this is rate-limited right now. Try again in ${humanWait(secs * 1000)}.`,
        effectiveUntil ? effectiveUntil - startedNow : undefined
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
    let lastAttempt: {
      reason: AIProviderErrorCode
      providerId: AIProviderId
      detail?: string
      failureClass?: AIFailureClass
      resetsAt?: number
    } | null = null
    const attempts: { catalogId: string; reason: string; failureClass?: AIFailureClass }[] = []
    // BUG-058 Phase 2 — this walk previously had NO early-exit at all, unlike
    // completeWithFallback's identical deadProviders mechanism: an auth
    // failure on entry 1 didn't stop entry 2 on the same now-known-dead
    // provider from being tried anyway. Ported verbatim, same two rules —
    // 'auth' skips the rest of that provider immediately (a bad key fails
    // identically on every model it offers); 'rate-limit' only skips after a
    // SECOND different model on the same provider also rate-limits within
    // this same walk (noteRateLimitForDeadProviders, above) — one rate-
    // limited model still proves nothing about its neighbors on its own.
    const deadProviders = new Set<AIProviderId>()
    // BUG-148 — de-duplicates auth rejections WITHIN this walk; see noteAuthRejection.
    const authNotedThisWalk = new Set<AIProviderId>()
    const rateLimitCountByProvider = new Map<AIProviderId, number>()

    // M27 A1 — one hard wall-clock ceiling across the ENTIRE stream walk,
    // mirroring completeWithFallback's BUG-059 fix exactly. Without this,
    // coaching-chat (this function's only consumer) had NO ceiling at all:
    // worst case was the full fallback chain (up to the uncapped 9-entry
    // QUALITY_CHAIN, reachable whenever a user's default provider key lapses
    // but others remain configured) x LATENCY_POLICY's per-attempt timeout,
    // unboundedly, with no way for the caller to cancel out of it — up to
    // ~13.5 minutes confirmed against the real chain-resolution logic. The
    // ceiling is always in the combined signal so it bounds the SDK's own
    // retries too, not just this loop's iteration.
    const ceiling = new AbortController()
    const ceilingTimer = setTimeout(() => ceiling.abort(), HARD_CEILING_MS[purpose])

    // BUG-125e — waits out a paced step's remaining gap, bounded and abortable.
    // Only ever reached for a paced-tail step (see pacedUntil above). The sleep
    // is capped at one full gap, runs under the SAME combined signal as the
    // attempts themselves (ceiling + caller Stop), and is logged so the wait is
    // visible in Settings' recent-activity list rather than reading as dead air.
    const waitOutPacingIfNeeded = async (step: ResolvedStep): Promise<void> => {
      const until = pacedUntil.get(step.catalogId)
      if (until === undefined) return
      const waitMs = Math.min(Math.max(0, until - Date.now()), PACING_GAP_MS)
      if (waitMs <= 0) return
      void logFallbackEvent({
        ts: new Date().toISOString(),
        purpose,
        fromCatalogId: step.catalogId,
        toCatalogId: step.catalogId,
        reason: 'paced-wait',
        detail: `Last-resort step is pacing-blocked; waiting ${waitMs}ms out instead of refusing (BUG-125).`
      })
      const parts: AbortSignal[] = [ceiling.signal]
      if (req.signal) parts.push(req.signal)
      await abortableSleep(waitMs, parts.length === 1 ? parts[0] : AbortSignal.any(parts))
    }

    try {
    // BUG-142 — the same two-pass structure as completeWithFallback, for the
    // same reason, with the loop body left untouched. See endOfWalkRescue.
    //
    // The "already shown output" guard below is preserved for free: once a
    // stream has emitted deltas it THROWS rather than breaking, which exits
    // this try entirely, so pass 1 is unreachable for a partially-rendered
    // answer. A rescue that appended a second provider's text to a half-
    // written one would be a worse bug than the one being fixed.
    //
    // `scanFrom` is REQUIRED here and has no counterpart in
    // completeWithFallback, because this loop keeps no `attempted` set — it
    // relies on the chain being deduped by construction, which was true while
    // there was only ever one pass. Without it, pass 1 re-walks every step
    // pass 0 already tried and re-issues each doomed request. Caught by
    // deadProvidersPhase2's ported stream test failing by TWO extra entries
    // where its completeWithFallback twin failed by one — the asymmetry
    // between two tests named as identical was the entire tell.
    let scanFrom = 0
    for (let pass = 0; pass < 2; pass++) {
    for (let i = scanFrom; i < chain.length; i++) {
      if (ceiling.signal.aborted) break
      const step = chain[i]
      if (deadProviders.has(step.providerId)) continue
      const key = providerHasCredentials(step.providerId)
        ? process.env[PROVIDER_REGISTRY[step.providerId].keyEnvName]?.trim()
        : undefined
      if (!key) continue
      await waitOutPacingIfNeeded(step)
      if (req.signal?.aborted) {
        // BUG-125e follow-up (2026-08-28): every OTHER error path in this
        // generator settles `final` before throwing (that's the whole point
        // of the rejectFinal/final split — a caller that only awaits `.final`
        // after the loop, per assistant-ipc.ts's documented pattern, must
        // still observe the failure). This one didn't, so a real Stop during
        // a paced wait left `.final` pending forever — found only once a
        // test started actually awaiting `.final` and hung on it.
        const abortErr = new Error('aborted by caller during paced wait')
        rejectFinal(abortErr)
        throw abortErr
      }
      if (ceiling.signal.aborted) break
      if (
        pacedUntil.has(step.catalogId) &&
        !isUsableFor(step.catalogId, Date.now(), tier, { purpose, ignorePacing: true })
      ) {
        continue
      }
      const provider = PROVIDER_REGISTRY[step.providerId].build(key)

      const parts: AbortSignal[] = [ceiling.signal]
      if (req.signal) parts.push(req.signal)
      const attemptSignal = parts.length === 1 ? parts[0] : AbortSignal.any(parts)

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
        // M27 A1 — matches completeWithSameModelRetry's identical guard: once
        // the combined signal is aborted (the ceiling fired, or the caller
        // cancelled), a same-model retry can only fail the same way again —
        // skip straight to the failure handling below instead of burning a
        // pointless extra attempt.
        if (attemptSignal.aborted) {
          stepErr = stepErr ?? new AIProviderError('timeout', 'Aborted.')
          break
        }
        try {
          const streamResult = provider.stream({
            ...req,
            model: step.modelId || undefined,
            signal: attemptSignal
          })
          for await (const chunk of streamResult) {
            startedStreaming = true
            stepStartedStreaming = true
            fullText += chunk.delta
            yield chunk
          }
          const usage = await streamResult.usage
          clearCooldown(step.catalogId, purpose)
          // BUG-148 — the streaming walk restores a demoted provider on its
          // own success too. Both walks record auth rejections, so both must
          // be able to clear them; clearing on only one side would let a
          // provider that streams fine stay demoted forever on the strength
          // of a stale rejection.
          clearDemotion(step.providerId)
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
            await abortableSleep(Math.min(200 * 2 ** attempt, 2_000), attemptSignal)
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
        const failureClass = err instanceof AIProviderError ? effectiveFailureClass(err) : 'transient'
        const resetsAt = err instanceof AIProviderError ? err.resetsAt : undefined
        lastAttempt = { reason: reason as AIProviderErrorCode, providerId: step.providerId, detail, failureClass, resetsAt }
        if (reason === 'auth') {
          deadProviders.add(step.providerId)
          // BUG-148 — the rejection is now REMEMBERED, not merely survived.
          // authNotedThisWalk holds one walk to at most one rejection per
          // provider: a walk can attempt the same key twice (a legacy step plus
          // a bundled entry on the same provider), and counting those separately
          // would demote on the strength of ONE call — the one-strike option
          // that was deliberately not chosen.
          if (!authNotedThisWalk.has(step.providerId)) {
            authNotedThisWalk.add(step.providerId)
            noteAuthRejection(step.providerId, Date.now())
          }
        }
        // M27 B3 — gated on failureClass alone; see completeWithFallback's
        // identical branch for the full reasoning (a 'failed'-coded quota
        // exhaustion, e.g. Groq's own "out of quota/credits" message, was
        // being thrown away here for the same reason).
        if (failureClass === 'period-exhausted') {
          markPeriodExhausted(
            step.catalogId,
            err instanceof AIProviderError ? err.retryAfterMs : undefined,
            Date.now(),
            tier,
            resetsAt
          )
          // BUG-058 remainder — pacing marks alongside cooldown, on the same
          // period-exhausted classification as the branch above.
          markUsed(step.catalogId, Date.now(), tier)
          noteRateLimitForDeadProviders(step.providerId, rateLimitCountByProvider, deadProviders)
        } else if (reason === 'rate-limit') {
          markRateLimited(
            step.catalogId,
            err instanceof AIProviderError ? err.retryAfterMs : undefined,
            Date.now(),
            tier
          )
          markUsed(step.catalogId, Date.now(), tier)
          noteRateLimitForDeadProviders(step.providerId, rateLimitCountByProvider, deadProviders)
        } else if (failureClass === 'structural' && reason !== 'auth') {
          markStructurallyBroken(step.catalogId, Date.now(), purpose, detail ? `${reason}: ${detail}` : reason)
        } else if (failureClass === 'transient' && reason !== 'auth') {
          // BUG-154 follow-up — repetition IS the evidence.
          //
          // A transient class means "this might work next time", and for a
          // sampling-dependent malformed generation that is true. It stops being
          // true after the third identical failure with no success in between,
          // and until this branch existed nothing counted them: Groq's
          // tool_use_failed is deliberately transient (openai-compatible.ts), so
          // live cues retried the same model every ~7s indefinitely and showed
          // the user nothing. Measured at twelve consecutive failures across two
          // real calls before this was added.
          //
          // noteTransientFailure escalates to a purpose-scoped structural break
          // at its threshold and returns whether IT did, so the escalation is
          // logged rather than being a silent state change. Any success clears
          // the streak (clearCooldown), so a model that recovers is asked again
          // at once instead of serving out the break.
          // The escalation is self-describing without a logger: the reason string
          // passed to markStructurallyBroken surfaces verbatim in the exhaustion
          // report the user actually reads ("benched up to 4h by a STRUCTURAL
          // BREAK after..."), which is this file's existing convention — it
          // imports no logger on purpose.
          void noteTransientFailure(step.catalogId, Date.now(), purpose)
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
          void recordAiFailure(purpose, {
            reason: reason as AIProviderErrorCode,
            providerId: step.providerId,
            detail,
            failureClass,
            resetsAt
          })
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
    if (pass === 0) {
      if (ceiling.signal.aborted) break
      // No `attempted` set here: unlike completeWithFallback this loop keeps
      // none, and none is needed — rescueSteps already excludes every provider
      // represented in `chain`, and deadProviders excludes the one whose key
      // was just rejected. So no candidate it returns can be a step this walk
      // already tried.
      const extra = endOfWalkRescue(
        chain,
        new Set<string>(),
        deadProviders,
        Date.now(),
        tier,
        purpose
      )
      if (extra.length === 0) break
      void logFallbackEvent({
        ts: new Date().toISOString(),
        purpose,
        fromCatalogId: lastAttempt
          ? `legacy:${lastAttempt.providerId}`
          : (chain[chain.length - 1]?.catalogId ?? 'chain-exhausted'),
        toCatalogId: extra[0].catalogId,
        reason: 'rescue',
        detail:
          `Chain exhausted; offering ${extra.length} keyed provider not yet tried ` +
          `(BUG-142). This is the fall-through a rejected key used to block.`
      })
      // Advance PAST everything pass 0 walked, THEN append. Order matters:
      // reading chain.length after the append would scan from the end and try
      // nothing at all.
      scanFrom = chain.length
      chain = [...chain, ...extra]
    }
    }
    } finally {
      clearTimeout(ceilingTimer)
    }

    if (ceiling.signal.aborted) {
      // M27 A1 — same distinction completeWithFallback's identical check
      // makes: "we ran out of time" vs. "every model rejected us" are
      // different problems with different user actions, and collapsing them
      // is how the unbounded hang stayed invisible in the first place.
      void recordAiFailure(purpose, {
        reason: 'timeout',
        providerId: lastAttempt?.providerId ?? null,
        detail: lastAttempt?.detail
      })
      const timeoutErr = new AIProviderError(
        'timeout',
        `This took too long and was stopped after ${Math.round(HARD_CEILING_MS[purpose] / 1000)}s. Your AI provider may be rate-limiting or slow right now — try again shortly.`
      )
      rejectFinal(timeoutErr)
      throw timeoutErr
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
      detail: lastAttempt?.detail,
      failureClass: lastAttempt?.failureClass,
      resetsAt: lastAttempt?.resetsAt
    })
    const finalErr = new AllModelsExhaustedError(purpose, attempts, notTried)
    rejectFinal(finalErr)
    throw finalErr
  }

  return Object.assign(generator(), { final })
}

// Re-exported so call sites and Settings only need one import site for the
// M20 latency-policy constant that drives the chain-length cap.
export { LATENCY_POLICY }
