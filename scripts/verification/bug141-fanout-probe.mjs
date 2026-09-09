/**
 * BUG-141 mechanism B — is the unbounded `Promise.all` fan-out in the record
 * stores a real problem, and would bounding it actually help?
 *
 * `listCalls` (calls-fs.ts:1147), `listDeals` (deals-fs.ts:303) and
 * `listContacts` (contacts-fs.ts:430) each read EVERY record file in one
 * `Promise.all`. On the founder's profile that is 487 + 22 + 49 files, and
 * `deal-backfill.ts` calls several of them in parallel — so one backfill step
 * issues ~550 concurrent reads. The instrument caught exactly that shape:
 * `reqs={'FSReqPromise':358}` with `resolving=[]`, i.e. queued filesystem work,
 * not the module-transform stall of mechanism A.
 *
 * calls-fs.ts:1145 justifies the fan-out in a comment:
 *
 *     "Reads run concurrently — one file's disk I/O never waits on another's"
 *
 * That is true for the first FOUR reads. libuv's threadpool defaults to 4
 * threads, so read #5 waits for read #1, and #487 waits for 483 of them. This
 * probe measures what the comment asserts.
 *
 * TWO NUMBERS, and the second is the one that matters:
 *   1. TOTAL time to read N files, unbounded vs bounded. Bounding cannot make
 *      this faster — the same 4 threads do the same work either way. If it
 *      does not get worse, bounding is free.
 *   2. LATENCY OF A SMALL UNRELATED WRITE issued while the fan-out is in
 *      flight. This is the fairness cost: a `writeJsonAtomic` from any other
 *      part of the app queues behind the whole fan-out, because the threadpool
 *      is process-wide and shared.
 *
 * Usage: node scripts/verification/bug141-fanout-probe.mjs [dir] [limit]
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DIR = process.argv[2] ?? 'C:/Users/User/AppData/Roaming/sales-os/calls'
const LIMIT = Number(process.argv[3] ?? 8)

const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.json')).map((f) => join(DIR, f))
console.log(`${files.length} record files in ${DIR}`)
console.log(`libuv threadpool: ${process.env.UV_THREADPOOL_SIZE ?? '4 (default)'}`)

/** A small write on an unrelated file, timed — stands in for writeJsonAtomic
 *  being issued by anything else while a list is in flight. */
async function timeUnrelatedWrite(scratch) {
  const p = join(scratch, `probe-${randomUUID()}.json`)
  const t = process.hrtime.bigint()
  await fs.writeFile(p, '{"a":1}', 'utf8')
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  await fs.unlink(p).catch(() => {})
  return ms
}

async function unbounded(paths) {
  return Promise.all(paths.map((p) => fs.readFile(p, 'utf8')))
}

async function bounded(paths, limit) {
  const out = new Array(paths.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= paths.length) return
      out[i] = await fs.readFile(paths[i], 'utf8')
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return out
}

const scratch = await fs.mkdtemp(join(tmpdir(), 'fanout-probe-'))

for (const [label, run] of [
  ['UNBOUNDED (what the stores do today)', () => unbounded(files)],
  [`BOUNDED to ${LIMIT}`, () => bounded(files, LIMIT)]
]) {
  // warm the page cache identically for both arms, so this measures queueing
  // rather than one arm paying for the other's cold reads
  await bounded(files, 4)

  const writes = []
  let stop = false
  const sampler = (async () => {
    while (!stop) {
      writes.push(await timeUnrelatedWrite(scratch))
      await new Promise((r) => setTimeout(r, 5))
    }
  })()

  const t0 = process.hrtime.bigint()
  await run()
  const total = Number(process.hrtime.bigint() - t0) / 1e6
  stop = true
  await sampler

  writes.sort((a, b) => a - b)
  const p = (q) => writes[Math.min(writes.length - 1, Math.floor((q / 100) * writes.length))]
  console.log(
    `\n${label}\n  total read of ${files.length} files: ${total.toFixed(0)} ms` +
      `\n  an unrelated small write, sampled ${writes.length}x during it:` +
      ` p50 ${p(50).toFixed(1)} ms  p95 ${p(95).toFixed(1)} ms  MAX ${writes[writes.length - 1].toFixed(1)} ms`
  )
}

await fs.rm(scratch, { recursive: true, force: true })
