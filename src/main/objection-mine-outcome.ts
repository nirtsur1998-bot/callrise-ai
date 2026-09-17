// BUG-274 (BUG-271's shape in a second place) — what happened to one call's
// objection-mining attempt, and what the auto-mine JOB says about it.
//
// The miner (objection-mining.ts) has always classified its own failures: a
// missing key says so, and an exhausted provider chain carries
// summarizeExhaustion()'s wait / add-a-key / bug message. Two hops later none
// of it survived: mineCallIntoQueue collapsed every failure to
// `{ ok: false, added: 0 }`, and the job threw one constant sentence. A rate
// limit, a rejected key and a parser failure all produced "Could not mine
// this call for objections." in the Activity Center — on a call whose
// what-changed section and objection library then silently had nothing.
//
// Kept out of calls.ts so it can be tested without standing up that module's
// whole IPC surface; calls.ts is the only production caller.
import type { ObjectionMiningResult } from './objection-mining'

/** What happened to one call's mining attempt. `skipped` is deliberately
 *  DISTINCT from `ok: false` — see mineCallIntoQueue's own doc comment. */
export interface MineCallOutcome {
  ok: boolean
  added: number
  /** True when nothing was attempted because this exact call was already
   *  being mined by the other trigger right now. Not a failure — the other
   *  attempt is still running and will mark the call mined itself. */
  skipped?: boolean
  /** True when there was simply nothing to mine (no transcript). Also not a
   *  failure: separated out because the auto-mine JOB surfaces its outcome
   *  in the Activity Center, where reporting a transcript-less call as
   *  "Looking for objections — failed" would be a false alarm about a call
   *  that was never minable in the first place. */
  nothingToMine?: boolean
  /** On a genuine failure: the miner's own classification and sentence,
   *  carried through instead of dropped. */
  error?: 'no-key' | 'disabled' | 'failed'
  message?: string
}

export const GENERIC_MINE_FAILURE = 'Could not mine this call for objections.'

/** A failed MineResult, as a MineCallOutcome that still knows why. */
export function failedMineOutcome(
  result: Extract<ObjectionMiningResult, { ok: false }>
): MineCallOutcome {
  return { ok: false, added: 0, error: result.error, message: result.message }
}

/**
 * The auto-mine job's verdict for one outcome: the string a finished job
 * reports, or a thrown Error for a genuine failure — whose message is the
 * CAUSE when the miner gave one. The generic sentence stays as a prefix so
 * the Activity Center row still says which feature failed.
 */
export function autoMineJobResult(res: MineCallOutcome): string {
  if (res.skipped) return 'already being mined by the past-calls scan'
  if (res.nothingToMine) return 'no transcript to mine'
  if (!res.ok) {
    const cause = res.message?.trim()
    throw new Error(cause ? `${GENERIC_MINE_FAILURE} ${cause}` : GENERIC_MINE_FAILURE)
  }
  return `found ${res.added} suggestion${res.added === 1 ? '' : 's'}`
}
