import type { GenerateTitleResult } from './call-title'

/**
 * BUG-232 — the title backfill's loop, as pure logic.
 *
 * Extracted from the job executor for the same reason `objection-scan-tally.ts`
 * was: the interesting behaviour here is CANCELLATION and FAILURE REPORTING,
 * and neither is testable through a JobManager without standing up the whole
 * queue. The executor in calls.ts is now only wiring.
 *
 * WHAT IT MUST GET RIGHT, and why each one is a requirement rather than a
 * preference:
 *
 *  - STOPPING PARTWAY IS A SUCCESS, not an error. The founder asked for "one
 *    action, and let me stop partway". Everything named before the stop stays
 *    named, and the summary says the run was stopped rather than pretending it
 *    finished.
 *  - THE FAILURE LIST IS PER CALL. "If 20 of 128 fail, I want to see which and
 *    why rather than ending with 108 titles and no explanation." An aggregate
 *    count is the exact reporting shape that let BUG-227 hide for five weeks;
 *    the clean-up for that bug must not repeat it.
 *  - ONE FAILURE NEVER STOPS THE RUN. A rate-limited provider mid-way through
 *    128 calls would otherwise abandon the remaining hundred, and the next
 *    attempt would start over.
 */
export interface TitleBackfillFailure {
  callId: string
  callTitle: string
  reason: 'no-transcript' | 'no-title-returned' | 'ai-failed' | 'save-failed'
  detail?: string
}

export interface TitleBackfillSummary {
  attempted: number
  titled: number
  failures: TitleBackfillFailure[]
  stoppedEarly: boolean
}

export interface BackfillCandidate {
  id: string
  title: string
}

export interface RunTitleBackfillOptions {
  /** Checked BEFORE each call, so Stop takes effect at the next boundary
   *  rather than after the whole list. */
  isAborted: () => boolean
  /** Title one call. Injected so this module never touches the filesystem,
   *  the AI, or the job queue. */
  titleOne: (callId: string) => Promise<GenerateTitleResult>
  onProgress?: (done: number, total: number) => void
}

export async function runTitleBackfill(
  candidates: BackfillCandidate[],
  { isAborted, titleOne, onProgress }: RunTitleBackfillOptions
): Promise<TitleBackfillSummary> {
  const summary: TitleBackfillSummary = {
    attempted: 0,
    titled: 0,
    failures: [],
    stoppedEarly: false
  }
  onProgress?.(0, candidates.length)
  for (const c of candidates) {
    if (isAborted()) {
      summary.stoppedEarly = true
      break
    }
    summary.attempted += 1
    // A throw here is a failure of ONE call, never of the run. titleOneCall
    // already catches, but this loop must not depend on that: the contract it
    // relies on should be enforced where it is relied upon.
    let outcome: GenerateTitleResult
    try {
      outcome = await titleOne(c.id)
    } catch (err) {
      outcome = {
        ok: false,
        reason: 'ai-failed',
        detail: err instanceof Error ? err.message : String(err)
      }
    }
    if (outcome.ok) summary.titled += 1
    else
      summary.failures.push({
        callId: c.id,
        callTitle: c.title,
        reason: outcome.reason,
        detail: outcome.detail
      })
    onProgress?.(summary.attempted, candidates.length)
  }
  return summary
}

/** The one-line version shown in the Activity Center. Deliberately names the
 *  failures rather than only the successes — "108 titled" on its own is the
 *  shape of report this milestone exists to stop writing. */
export function titleBackfillResultRef(r: TitleBackfillSummary): string {
  const stopped = r.stoppedEarly ? ', stopped early' : ''
  return r.failures.length === 0
    ? `${r.titled} titled${stopped}`
    : `${r.titled} titled, ${r.failures.length} could not be named${stopped}`
}
