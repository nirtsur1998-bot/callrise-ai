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
}

describe('Memory Quality Eval Harness (M27 audit — Sales Brain extraction baseline)', () => {
  const hasKey = anyProviderKeyConfigured()

  it(
    hasKey
      ? 'runs extraction against scripted transcripts and reports precision/recall'
      : 'FAILS LOUDLY — no AI provider key, so extraction quality is UNMEASURED',
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
        const outcome = await extractMemoriesFromCall(scenario.segments, `eval:${scenario.id}`, scenario.contactId)
        expect(outcome.aiFailed).toBe(false) // the pipeline itself must not error — a real failure here IS a bug, unlike a low score

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
          unexpectedByTopic
        })
      }

      printReport(reports)
    },
    120_000
  )
})

function printReport(reports: ScenarioReport[]): void {
  console.log('\n=== Memory Quality Eval Harness — baseline report ===\n')

  let totalExpected = 0
  let totalHit = 0
  let totalExtracted = 0
  let totalForbiddenHits = 0

  for (const r of reports) {
    totalExpected += r.truePositives.length + r.falseNegatives.length
    totalHit += r.truePositives.length
    totalExtracted += r.extracted.length
    totalForbiddenHits += r.unexpectedByTopic.length

    const recall =
      r.truePositives.length + r.falseNegatives.length > 0
        ? (r.truePositives.length / (r.truePositives.length + r.falseNegatives.length)) * 100
        : 100

    console.log(`--- ${r.label} (${r.id}) ---`)
    console.log(`  Extracted ${r.extracted.length} candidate(s). Recall on ground truth: ${recall.toFixed(0)}%`)
    for (const tp of r.truePositives) console.log(`  [HIT ] ${tp.description}\n         -> "${tp.matchedStatement}"`)
    for (const fn of r.falseNegatives) console.log(`  [MISS] ${fn.description}`)
    for (const u of r.unexpectedByTopic) console.log(`  [FALSE POSITIVE - forbidden topic '${u.topic}'] "${u.statement}"`)
    console.log('  All raw candidates:')
    for (const c of r.extracted)
      console.log(`    - [${c.category}] ${c.statement} (confidence ${c.confidence}, importance ${c.importance})`)
    console.log('')
  }

  const overallRecall = totalExpected > 0 ? (totalHit / totalExpected) * 100 : 0
  console.log('=== Summary ===')
  console.log(`Ground-truth facts: ${totalExpected}, hit: ${totalHit}, overall recall: ${overallRecall.toFixed(0)}%`)
  console.log(`Total candidates extracted across all scenarios: ${totalExtracted}`)
  console.log(`Forbidden-topic false positives: ${totalForbiddenHits}`)
  console.log('===================================================\n')
}
