// BUG-244 — the retry wrapper for writes that must not be dropped silently.
//
// IT LIVES IN ITS OWN FILE ON PURPOSE. It was first written inside
// atomic-write.ts, next to writeJsonAtomic, and that made it untestable: an
// ESM module calling its own export calls the local binding directly, so a
// spy on the module object never intercepts it and the retry test passed
// vacuously with the writer never called at all. Crossing a module boundary
// is what gives the test a seam it can actually hold.
import { writeJsonAtomic } from './atomic-write'

/**
 * Codes that mean "someone else had the file open for a moment", as opposed to
 * "this write is never going to work". On Windows a rename over an existing
 * target fails this way when any other process holds a handle on either side —
 * a virus scanner or an indexer touching a file we created milliseconds ago is
 * the usual culprit. They clear on their own in milliseconds.
 *
 * ENOSPC, EROFS, EACCES-on-a-real-permission-problem and friends are
 * deliberately NOT here: retrying those just wastes time before the same
 * failure.
 */
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

/**
 * Write a record that MUST NOT be dropped silently, retrying the transient
 * Windows sharing violations that `writeJsonAtomic` is exposed to.
 *
 * BUG-244 — `writeJsonAtomic`'s `rename` was observed failing with **EPERM** on
 * the founder's own machine under load (2026-09-09), on a real store's state
 * file. The atomic guarantee holds when that happens (the previous complete
 * file survives) but **the write is lost**, and callers that swallowed the
 * rejection lost the user's intent with it.
 *
 * Use this for a DURABLE QUEUE — a record of work the user asked for, where
 * losing the write loses the request rather than merely a cached value. For an
 * ordinary store write, `writeJsonAtomic` and a propagated rejection is right;
 * this exists for the callers that cannot propagate because nobody is waiting.
 *
 * BOUNDED, and the bound is the point. Three attempts, ~40 ms then ~120 ms
 * apart: a sharing violation clears in milliseconds, so this either works
 * almost immediately or is not going to. An UNBOUNDED retry here would
 * manufacture exactly the multi-second stall [[BUG-141]] is about, inside a
 * path the user is waiting on.
 *
 * Never throws. Returns whether the record actually reached disk, so a caller
 * that CAN do something about a failure has something to branch on, and
 * reports through `onFailure` when it did not — because the one thing this
 * must not do is what it replaced: fail in silence.
 */
export async function writeJsonAtomicDurable(
  path: string,
  value: unknown,
  what: string,
  opts: {
    attempts?: number
    delaysMs?: number[]
    onFailure?: (what: string, err: unknown, attempts: number) => void
  } = {}
): Promise<boolean> {
  const delays = opts.delaysMs ?? [40, 120]
  const attempts = opts.attempts ?? delays.length + 1
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      await writeJsonAtomic(path, value)
      return true
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      // A non-transient failure will not improve; stop rather than sleep on it.
      if (!code || !TRANSIENT_WRITE_CODES.has(code)) break
      const wait = delays[i]
      if (wait === undefined) break
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  const report =
    opts.onFailure ??
    ((w: string, err: unknown, n: number): void => {
      console.error(
        `[atomic-write] ${w} could not be persisted after ${n} attempt(s) — the request is LOST, not deferred:`,
        err
      )
    })
  try {
    report(what, lastErr, attempts)
  } catch {
    /* a reporting failure must never be worse than the write failure */
  }
  return false
}
