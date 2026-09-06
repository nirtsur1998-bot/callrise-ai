// M27 audit — Memory Quality Eval Harness.
//
// WHAT THIS IS: a runnable precision/recall baseline for the Sales Brain
// extraction prompt (extraction.ts's GUARDRAIL_PROMPT + EXTRACT_TOOL),
// against three realistic, hand-authored transcripts (see ./fixtures/
// memory-eval-transcripts.ts) with known ground-truth facts, scored per
// topical category (budget / timeline / decision-maker / pain-point /
// objection).
//
// WHAT THIS IS NOT: a correctness unit test. It calls the REAL
// extractMemoriesFromCall(), which calls the REAL completeWithFallback(),
// which makes a REAL network call to whichever AI provider has a key in
// process.env (same bundled-default-chain path a fresh install uses — see
// complete-with-fallback.ts's module doc comment). LLM output is
// non-deterministic and this repo has no test-fixture AI provider, so this
// file intentionally asserts almost nothing about the SCORES — it prints a
// report and only fails if the pipeline itself breaks (throws, or the
// AI call errors outright). Treat the printed report as the actual
// deliverable, read by a human, not as a red/green gate.
//
// WHY IT'S GATED ON PROCESS.ENV, NOT SKIPPED BY DEFAULT: same convention as
// this codebase's other opt-in-network tests — see
// memory-hooks.client-scope.test.ts for the vi.mock('electron', ...)
// pattern this file reuses (electron itself is the only real dependency
// extraction.ts's chain needs stubbed; app-settings.ts is left UNMOCKED so
// it exercises the real "no configured provider -> bundled default chain"
// fallback path, exactly like a fresh install with only an env-var key).
//
// RUN IT FOR REAL:
//   ANTHROPIC_API_KEY=sk-... npx vitest run src/main/memory/__tests__/memory-quality-eval.test.ts
// (or OPENAI_API_KEY / GROQ_API_KEY / any provider in ai/registry.ts's
// keyEnvName list — the bundled default chain tries all of them in order).
//
// In THIS audit environment there is no provider key in process.env (only
// ANTHROPIC_BASE_URL is set, which is not a key) — confirmed by grepping
// the shell env directly. So this run reports "SKIPPED — no AI provider key
// configured" rather than fabricated numbers. That is the harness doing its
// job, not a failure to build it: everything downstream of "get an API key
// into this environment" is now a one-command run, not a research problem.
import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_REGISTRY } from '../../ai/registry'
import { EVAL_SCENARIOS, type EvalTopic } from './fixtures/memory-eval-transcripts'
import type { MemoryCandidate } from '../types'

vi.mock('electron', () => ({
  app: { getPath: () => require('node:os').tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    on(): void {}
    show(): void {}
  }
}))

const { extractMemoriesFromCall } = await import('../extraction')

function anyProviderKeyConfigured(): boolean {
  return Object.values(PROVIDER_REGISTRY).some((entry) => !!process.env[entry.keyEnvName]?.trim())
}

/**
 * AUDIT FIX (2026-08-24) — an EXPLICIT opt-in, not just "is a key lying
 * around in process.env".
 *
 * Found while checking whether this file's new loud failure actually fires:
 * two consecutive full-suite runs disagreed (2216 passed, then 1 failed |
 * 2215 passed) with no change to this file in between. The cause is that a
 * provider key in process.env is not a stable fact during a test run — more
 * than ten sibling files under src/main/ai/__tests__ assign
 * process.env.GROQ_API_KEY (and friends), vitest reuses a worker process
 * across files, and `hasKey` here is evaluated at COLLECTION time. Whether
 * this harness saw a key therefore depended on worker scheduling.
 *
 * That is worse than a flaky result. The key those siblings set is fake, but
 * the branch it unlocks is the REAL one: an ordinary `npm test` could start
 * firing live extraction requests at a provider, spending real quota, because
 * an unrelated test set an env var and vitest happened to schedule the two
 * files together.
 *
 * So measurement now requires a deliberate CALLRISE_EVAL=1, which nothing
 * else in the suite sets. A stray key can no longer trigger a network run,
 * and the outcome no longer depends on scheduling.
 */
const OPTED_IN = process.env.CALLRISE_EVAL === '1'

const TOPIC_KEYWORDS: Record<EvalTopic, string[][]> = {
  budget: [['budget'], ['price'], ['cost'], ['$'], ['invest']],
  timeline: [['timeline'], ['deadline'], ['quarter'], ['q1'], ['q2'], ['q3'], ['q4'], ['go live'], ['go-live']],
  'decision-maker': [
    ['decision'],
    ['authority'],
    ['approv'],
    ['sign off'],
    ['sign-off'],
    ['stakeholder'],
    ['director'],
    ['finance team']
  ],
  'pain-point': [['manual'], ['spreadsheet'], ['struggle'], ['problem'], ['pain'], ['frustrat'], ['bottleneck']],
  objection: [['objection'], ['concern'], ['hesitant'], ['not sure'], ["can't"], ['cannot'], ['not in the budget']]
}

/** Eval-only classifier — see fixtures file's doc comment on why this can't
 *  just read `candidate.category` (the real schema only has 'client-fact'
 *  for every one of these). A statement can land in more than one bucket;
 *  that's fine, precision/recall are computed per-bucket independently. */
function classify(statement: string): EvalTopic[] {
  const s = statement.toLowerCase()
  return (Object.keys(TOPIC_KEYWORDS) as EvalTopic[]).filter((topic) =>
    TOPIC_KEYWORDS[topic].some((group) => group.every((kw) => s.includes(kw)))
  )
}

function hits(candidates: MemoryCandidate[], hitIfContainsAllOf: string[][]): MemoryCandidate | undefined {
  return candidates.find((c) => {
    const s = c.statement.toLowerCase()
    return hitIfContainsAllOf.some((group) => group.every((kw) => s.includes(kw)))
  })
}

interface ScenarioReport {
  id: string
  label: string
  extracted: MemoryCandidate[]
  truePositives: { description: string; matchedStatement: string }[]
  falseNegatives: { description: string }[]
  unexpectedByTopic: { topic: EvalTopic; statement: string }[]
  /** BUG-196 — the model that answered; a number without its model is a number about nothing */
  servedBy: string
  /** BUG-195 — how many attempts the scenario took and why the earlier ones failed */
  attempts: string[]
  /** BUG-196 — what the model proposed and the guardrails refused, with the reason, and
   *  whether the refused statement would have satisfied a ground-truth fact */
  rejected: { statement: string; category: string; reason: string; wouldHaveHit: string | null }[]
  /** BUG-196 shape (b) — kept as client-fact in the client scope after a rep/business category
   *  claim; how much of the recall the remap is responsible for */
  remapped: { statement: string; from: string }[]
}

/** BUG-195 — two of the first three real runs failed INSIDE a model (malformed
 *  tool-call JSON from Groq, no structured output from OpenRouter's free
 *  Nemotron). A harness that succeeds one run in three cannot measure a change,
 *  so each scenario is retried, the failures are recorded and printed, and the
 *  run fails only when every attempt failed. */
const MAX_ATTEMPTS_PER_SCENARIO = 3
const RETRY_BACKOFF_MS = 20_000
/** BUG-195 / BUG-196 — a before/after is only a measurement if the SAME model
 *  answered both sides. Set CALLRISE_EVAL_MODEL to the concrete model id the
 *  run must be served by (e.g. `gemini-2.5-flash`, as reported by
 *  AICompletionResult.model); any scenario served by another model fails the
 *  run instead of quietly contributing a number about a different system. */
const REQUIRED_MODEL = process.env.CALLRISE_EVAL_MODEL?.trim() || null

describe('Memory Quality Eval Harness (M27 audit — Sales Brain extraction baseline)', () => {
  const hasKey = anyProviderKeyConfigured()

  // NOT opted in: skip, with the truth in the test NAME so it reads as
  // "unmeasured" in the summary rather than as a pass.
  //
  // This is the deliberate difference from the sibling retrieval harness,
  // which was changed to a HARD failure on the same day. That one could run
  // offline all along, so its green-skip was actively false — it claimed
  // memory quality was verified when the model simply had not been cached.
  // This harness genuinely cannot run without a provider key and a network,
  // so "unmeasured" is the honest status, and a permanently-red default suite
  // for a known and accepted gap would just train everyone to ignore red —
  // the same end state as a hollow green, reached from the other side.
  //
  // What must never happen is a SILENT pass, and it no longer can: the name
  // says NEVER BASELINED, and vitest counts it under "skipped", not "passed".
  const testName = !OPTED_IN
    ? 'NEVER BASELINED — extraction quality is UNMEASURED (set CALLRISE_EVAL=1 plus a provider key)'
    : hasKey
      ? 'runs extraction against scripted transcripts and reports precision/recall'
      : 'FAILS LOUDLY — CALLRISE_EVAL=1 was set but no provider key is present'

  it.skipIf(!OPTED_IN)(
    testName,
    async () => {
      if (!hasKey) {
        // FAIL LOUDLY (2026-08-24, founder's instruction, applied BEFORE the
        // key lands rather than after).
        //
        // This used to `expect(hasKey).toBe(false)` and PASS: a green result
        // in ~4ms that measured nothing. That is the same hollow-skip the
        // sibling retrieval harness was fixed for on this branch — there, the
        // green-skip was actively false (that harness could run offline all
        // along). Here it is "only" a trap: extraction genuinely IS blocked on
        // a key, so the honest status is UNMEASURED. But a suite that reports
        // success for a run that measured nothing is a trap regardless of
        // whether anyone is relying on it today, and the next person to run
        // this without a key should be told so in one line rather than reading
        // a green tick and moving on.
        //
        // The status stays "never measured" — this change does not create a
        // baseline, it stops the absence of one from looking like a pass.
        const checked = Object.values(PROVIDER_REGISTRY)
          .map((e) => e.keyEnvName)
          .join(', ')
        throw new Error(
          'Memory-extraction quality harness could not run: no AI provider key in process.env ' +
            `(checked: ${checked}). This is a HARD FAILURE, not a skip — a green result here ` +
            'would claim extraction quality was verified when nothing was measured. Extraction ' +
            'quality has NEVER been baselined (owed since M27). Set a throwaway free-tier key and ' +
            "re-run to get the first real numbers: see this file's header comment for the command."
        )
      }

      const reports: ScenarioReport[] = []

      for (const scenario of EVAL_SCENARIOS) {
        const attempts: string[] = []
        let outcome = await extractMemoriesFromCall(scenario.segments, `eval:${scenario.id}`, scenario.contactId)
        while (outcome.aiFailed && attempts.length < MAX_ATTEMPTS_PER_SCENARIO - 1) {
          attempts.push(`attempt ${attempts.length + 1} failed: ${outcome.failureReason ?? '(no reason recorded)'}`)
          // free tiers rate-limit a burst of three scenarios; an immediate retry
          // just burns the remaining attempts inside the same window
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempts.length))
          outcome = await extractMemoriesFromCall(scenario.segments, `eval:${scenario.id}`, scenario.contactId)
        }
        // the pipeline itself must not error — a real failure here IS a bug, unlike a low score.
        // The provider's own reason rides on the assertion (2026-09-06): the first real run
        // failed in 200ms with "expected true to be false" and nothing else, which is a
        // shrug, not a finding.
        expect(
          outcome.aiFailed,
          `AI call failed for ${scenario.id} on every attempt: ${outcome.failureReason ?? '(no reason recorded)'}\n${attempts.join('\n')}`
        ).toBe(false)

        // BUG-196 — a refused candidate that would have satisfied a ground-truth
        // fact is the difference between "the model omitted it" and "we threw it
        // away"; name it per row
        const rejected: ScenarioReport['rejected'] = outcome.rejected.map((r) => {
          const statement = typeof r.raw.statement === 'string' ? r.raw.statement : JSON.stringify(r.raw)
          // category AND the scope the model claimed — a 'category-scope-mismatch' has a
          // direction, and the safe fix depends on which one
          const category = `${typeof r.raw.scopeKind === 'string' ? r.raw.scopeKind : '?'}/${typeof r.raw.category === 'string' ? r.raw.category : '?'}`
          const wouldHaveHit =
            scenario.expected.find((fact) => hits([{ statement } as MemoryCandidate], fact.hitIfContainsAllOf))?.description ?? null
          return { statement, category, reason: r.reason, wouldHaveHit }
        })

        const truePositives: ScenarioReport['truePositives'] = []
        const falseNegatives: ScenarioReport['falseNegatives'] = []
        for (const fact of scenario.expected) {
          const match = hits(outcome.candidates, fact.hitIfContainsAllOf)
          if (match) truePositives.push({ description: fact.description, matchedStatement: match.statement })
          else falseNegatives.push({ description: fact.description })
        }

        const unexpectedByTopic: ScenarioReport['unexpectedByTopic'] = []
        for (const candidate of outcome.candidates) {
          const topics = classify(candidate.statement)
          for (const topic of topics) {
            if ((scenario.expectNoTopics ?? []).includes(topic)) {
              unexpectedByTopic.push({ topic, statement: candidate.statement })
            }
          }
        }

        reports.push({
          id: scenario.id,
          label: scenario.label,
          extracted: outcome.candidates,
          truePositives,
          falseNegatives,
          unexpectedByTopic,
          servedBy: outcome.servedBy ?? '(model not recorded)',
          attempts,
          rejected,
          remapped: outcome.remapped
        })
      }

      printReport(reports)

      // the number is about ONE model, or it is about nothing
      if (REQUIRED_MODEL) {
        const strangers = reports.filter((r) => r.servedBy !== REQUIRED_MODEL).map((r) => `${r.id}: ${r.servedBy}`)
        expect(strangers, `CALLRISE_EVAL_MODEL=${REQUIRED_MODEL} but these scenarios were served by another model:\n${strangers.join('\n')}`).toEqual([])
      }
    },
    300_000 // three scenarios × up to two backed-off retries each
  )
})

function printReport(reports: ScenarioReport[]): void {
  console.log('\n=== Memory Quality Eval Harness — baseline report ===\n')

  let totalExpected = 0
  let totalHit = 0
  let totalExtracted = 0
  let totalForbiddenHits = 0
  let totalRefused = 0
  let totalRefusedWouldHaveHit = 0
  let totalRemapped = 0

  for (const r of reports) {
    totalExpected += r.truePositives.length + r.falseNegatives.length
    totalHit += r.truePositives.length
    totalExtracted += r.extracted.length
    totalForbiddenHits += r.unexpectedByTopic.length

    const recall =
      r.truePositives.length + r.falseNegatives.length > 0
        ? (r.truePositives.length / (r.truePositives.length + r.falseNegatives.length)) * 100
        : 100

    totalRefused += r.rejected.length
    totalRefusedWouldHaveHit += r.rejected.filter((x) => x.wouldHaveHit).length

    console.log(`--- ${r.label} (${r.id}) --- served by ${r.servedBy}${r.attempts.length ? ` after ${r.attempts.length} failed attempt(s)` : ''}`)
    for (const a of r.attempts) console.log(`  [ATTEMPT] ${a}`)
    console.log(`  Extracted ${r.extracted.length} candidate(s). Recall on ground truth: ${recall.toFixed(0)}%`)
    for (const tp of r.truePositives) console.log(`  [HIT ] ${tp.description}\n         -> "${tp.matchedStatement}"`)
    for (const fn of r.falseNegatives) console.log(`  [MISS] ${fn.description}`)
    for (const u of r.unexpectedByTopic) console.log(`  [FALSE POSITIVE - forbidden topic '${u.topic}'] "${u.statement}"`)
    console.log('  All raw candidates:')
    for (const c of r.extracted)
      console.log(`    - [${c.category}] ${c.statement} (confidence ${c.confidence}, importance ${c.importance})`)
    // BUG-196 — what the model proposed and the guardrails refused. This is the
    // line that separates "never proposed" from "proposed and dropped".
    console.log(`  Refused by verifyCandidate: ${r.rejected.length}`)
    for (const x of r.rejected)
      console.log(
        `    - [${x.category}] "${x.statement}" — ${x.reason}${x.wouldHaveHit ? `  *** WOULD HAVE HIT: ${x.wouldHaveHit}` : ''}`
      )
    // BUG-196 shape (b) — what the remap kept that the old rule would have dropped
    totalRemapped += r.remapped.length
    console.log(`  Kept by the client-fact remap (would have been refused before): ${r.remapped.length}`)
    for (const x of r.remapped) console.log(`    - "${x.statement}" (was filed as ${x.from})`)
    console.log('')
  }

  const overallRecall = totalExpected > 0 ? (totalHit / totalExpected) * 100 : 0
  console.log('=== Summary ===')
  console.log(`Ground-truth facts: ${totalExpected}, hit: ${totalHit}, overall recall: ${overallRecall.toFixed(0)}%`)
  console.log(`Total candidates extracted across all scenarios: ${totalExtracted}`)
  console.log(`Forbidden-topic false positives: ${totalForbiddenHits}`)
  console.log(
    `Refused by the guardrails: ${totalRefused}, of which would have hit a ground-truth fact: ${totalRefusedWouldHaveHit} ` +
      `(0 here means the misses are the MODEL's omissions, not the guardrails')`
  )
  console.log(`Kept by the client-fact remap across all scenarios: ${totalRemapped}`)
  console.log(`Served by: ${[...new Set(reports.map((r) => r.servedBy))].join(', ')}`)
  console.log('===================================================\n')
}
