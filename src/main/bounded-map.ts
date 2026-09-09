/**
 * BUG-248 — map over a list with a CONCURRENCY LIMIT, for the record stores
 * that read a whole directory at once.
 *
 * WHY THIS EXISTS. Eight stores read every file in their directory with a
 * single unbounded `Promise.all`, justified by a comment that said:
 *
 *     "Reads run concurrently — one file's disk I/O never waits on another's"
 *
 * **That is true for the first FOUR reads and false for the other 483.**
 * `fs.promises` is served by libuv's threadpool, which defaults to 4 threads,
 * so read #5 waits for read #1. It is not a wrong comment — it is a comment
 * that stops being true at read #5, and nobody reads a justification looking
 * for the boundary where it expires.
 *
 * The queue that forms is PROCESS-WIDE. It is the same pool that serves every
 * other store and every `writeJsonAtomic`, so on the founder's profile (487
 * call files) a single `listCalls` puts every other filesystem operation in the
 * main process behind 487 reads. Peak requests in flight, read straight from
 * libuv via `process._getActiveRequests`: **297 unbounded, 9 when bounded.**
 *
 * THIS IS A TRADE, AND THE FIRST VERSION OF THIS COMMENT SAID IT WAS NOT.
 * That claim ("bounding is faster on the read as well as fairer") came from a
 * probe whose own latency sampler ran for the duration of each arm — so the
 * slower arm was charged for extra sampler writes, and bounding looked free.
 * Measured again with no sampler, median of 5 runs, 296 real record files:
 *
 *   limit        read     an unrelated write issued mid-flight
 *   4            29 ms    0.8 ms
 *   8            23 ms    1.0 ms
 *   16           17 ms    1.2 ms   <- the knee, and the default below
 *   32           18 ms    2.1 ms
 *   64           17 ms    3.4 ms
 *   128          13 ms    6.2 ms
 *   unbounded    11 ms    9.2 ms
 *
 * Unbounded really is the fastest way to read one directory: it keeps the four
 * threads saturated with no scheduling gap between completions. Bounding costs
 * ~6 ms on a 296-file listing and takes a concurrent unrelated write from
 * 9.2 ms to 1.2 ms — **~7.7x fairness for ~55% more listing latency, 6 ms in
 * absolute terms.** Worth it in a main process where the thing waiting behind
 * the listing is a user's save, but it is a judgement, not a free win, and
 * species 103's test applies here as much as anywhere: this costs something
 * even to a caller that never had the problem.
 *
 * ORDER IS PRESERVED. The callers sort afterwards and would survive any order,
 * but a helper that silently reorders is a trap for the next caller that does
 * not sort.
 */

/**
 * IF YOU ARE HERE WONDERING WHY 16: it is not free, and it is not a rule of
 * thumb. It is a JUDGEMENT taken against the measured table above — 16 is where
 * the read cost stops falling and the fairness cost starts climbing, and the
 * trade bought there is **~6 ms of extra listing latency for a concurrent
 * unrelated write going 9.2 ms -> 1.2 ms**. The judgement is that the thing
 * queued behind a listing is usually a user's SAVE, and six milliseconds of
 * listing against a save waiting on 483 reads is not a close call. Change the
 * number if that reasoning stops holding; re-measure with
 * `scripts/verification/bug141-fanout-probe.mjs` rather than reasoning about
 * it. (The first value was 8, picked as "twice the threadpool" before the
 * trade had been measured at all; 8 costs 6 ms more on the read than 16 and
 * buys almost no extra fairness.) Deliberately NOT derived from
 * `UV_THREADPOOL_SIZE` —
 * raising that is a global change that trades a queue for disk saturation, and
 * this fix should not quietly depend on it being left alone.
 */
export const DEFAULT_READ_CONCURRENCY = 16

/**
 * Run `fn` over every item with at most `limit` in flight, returning results in
 * INPUT ORDER. Rejections propagate exactly as `Promise.all`'s would; every
 * caller in this codebase already catches per-item inside `fn` and returns
 * null, which is why there is no per-item error handling here.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_READ_CONCURRENCY
): Promise<R[]> {
  if (items.length === 0) return []
  const width = Math.max(1, Math.min(limit, items.length))
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return out
}
