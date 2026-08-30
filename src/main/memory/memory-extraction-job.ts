// M26 Phase 3 (Batch 5) — Sales Brain memory extraction as a background job.
//
// This one was gated on its own founder sign-off, unlike every other Batch 5
// item, because putting it behind a queue could change WHAT CLIENT DATA GETS
// STORED, not just when. The extraction logic itself is untouched; what
// changed is that the rule governing client-scoped memories is now stated
// explicitly (see MemoryExtractionPass in memory-hooks.ts) instead of
// emerging from a race that queue latency would have reversed.
import { getJobManager } from '../jobs/instance'
import { runMemoryExtractionForCall, type MemoryExtractionPass } from './memory-hooks'

export const MEMORY_EXTRACTION_JOB_TYPE = 'salesBrain:extractFromCall'

interface ExtractionJobInput {
  callId: string
  pass: MemoryExtractionPass
}

let registered = false

export function registerMemoryExtractionJob(): void {
  if (registered) return
  registered = true

  getJobManager().registerType<ExtractionJobInput, string>({
    type: MEMORY_EXTRACTION_JOB_TYPE,
    // BATCH, as approved in the Phase 0 lane assignments. Worth knowing: it
    // shares BATCH's single slot with the objection scan and the Sales Brain
    // backfill, so a long import can delay post-call learning by minutes.
    // That is a LATENCY cost only — never a correctness one, because the
    // pass/contactId decision is frozen at trigger time, which is exactly
    // what makes the lane choice safe to make on its merits.
    lane: 'BATCH',
    // M27 — the chain whose exhaustion makes this job pointless to start.
    aiPurpose: 'memory-extract',
    titleFor: () => 'Sales Brain: learning from this call',
    targetRefFor: (i) => i.callId,
    targetKind: 'call',
    // extraction.ts/consolidation.ts have no AbortSignal support, and adding
    // one would mean rewriting M25 internals — out of scope for an adapter.
    cancellable: false,
    // The feature fires its own, far better notification when it actually
    // learns something ("Sales Brain learned 3 things from this call —
    // click to review", with a deep link). Without this flag every call
    // would also produce a generic "learning from this call — done".
    silent: true,
    executor: {
      kind: 'inline-async',
      run: async (input) => {
        await runMemoryExtractionForCall(input.callId, input.pass)
        return input.callId
      }
    }
  })
}

/**
 * Enqueue one extraction pass. Replaces the bare fire-and-forget call in
 * calls.ts.
 *
 * Deliberately NO "already queued/running for this callId" dedupe: the
 * post-save and post-coach passes are BOTH wanted for the same call, and a
 * targetRef-keyed guard would silently swallow the second one — which is
 * the pass that does all the client-scoped learning.
 */
export function enqueueMemoryExtraction(callId: string, pass: MemoryExtractionPass): void {
  // Never allowed to throw into its caller. Both call sites sit inside the
  // calls:save handler and the coach job's executor, and the long-standing
  // invariant there is that a Sales Brain failure can never take down the
  // save or the coaching run — that used to be guaranteed by the
  // fire-and-forget `.catch(() => {})` this replaced. enqueue() genuinely
  // can throw (unregistered type), so the guarantee is kept explicitly.
  try {
    getJobManager().enqueue<ExtractionJobInput>(MEMORY_EXTRACTION_JOB_TYPE, { callId, pass })
  } catch (err) {
    console.error('[sales-brain] could not enqueue memory extraction:', err)
  }
}
