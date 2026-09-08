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
  /** Checked before AND after each call. */
  isAborted: () => boolean
  /**
   * Title one call. Injected so this module never touches the filesystem, the
   * AI, or the job queue.
   *
   * FOUNDER REPORT, 2026-09-08: "the stop button doesn't really stop it."
   * Correct, and the cause was here. This used to take no signal, so Stop was
   * only observed BETWEEN items — and one item is an AI call that was measured
   * at 55 seconds on a bad fallback chain. Pressing Stop on the first item
   * meant a minute of the UI still saying "Naming…" with nothing to show for
   * it, which is indistinguishable from a button that does nothing.
   *
   * The signal now reaches the provider SDK (every adapter threads
   * `req.signal`), so Stop lands inside the request rather than after it. Same
   * fix the objection scan already made for the same complaint — the answer
   * was one file away, which is species 16 again.
   */
  titleOne: (callId: string, opts: { signal: AbortSignal }) => Promise<GenerateTitleResult>
  /** Passed to `titleOne` so an in-flight AI call can be cut short. */
  signal: AbortSignal
  onProgress?: (done: number, total: number) => void
}

/** An abort is not a failure. When the rep presses Stop mid-request the SDK
 *  rejects, and recording that as "the AI call failed" would put a phantom
 *  entry in the failure list for a call nobody chose to fail. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === 'AbortError' || /abort/i.test(err.message)
  return false
}

export async function runTitleBackfill(
  candidates: BackfillCandidate[],
  { isAborted, titleOne, signal, onProgress }: RunTitleBackfillOptions
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
      outcome = await titleOne(c.id, { signal })
    } catch (err) {
      if (isAbortError(err)) {
        // Stopped INSIDE the request. This attempt did not happen as far as
        // the report is concerned — it is not a failure, and counting it as
        // one would tell the rep a call could not be named when in fact they
        // interrupted it.
        summary.attempted -= 1
        summary.stoppedEarly = true
        break
      }
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
    // Checked again AFTER the item: an abort that arrived while this call was
    // in flight but did not reject it (a fast success racing the click) must
    // still stop the run rather than starting one more.
    if (isAborted()) {
      summary.stoppedEarly = true
      break
    }
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
