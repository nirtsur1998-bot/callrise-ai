// BUG-141 probe — is a multi-second fsync stall PHYSICALLY AVAILABLE on this
// machine under the concurrency the test suite actually uses?
//
// This does NOT prove the timeout was caused by fsync. It answers a narrower,
// falsifiable question: can the operation `writeJsonAtomic` performs (write ->
// fsync file -> rename -> fsync parent dir) block for multiple seconds when N
// workers do it at once in tmpdir? If the worst case here is milliseconds, the
// filesystem hypothesis is dead and something else is stalling.
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'

const WORKERS = Number(process.argv[2] ?? 15)
const WRITES = Number(process.argv[3] ?? 40)

async function atomicWrite(dir, i) {
  const target = join(dir, `c-${i}.json`)
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ i, pad: 'x'.repeat(2000) }), 'utf8')
  const h = await fs.open(tmp, 'r+')
  try {
    await h.sync()
  } finally {
    await h.close()
  }
  await fs.rename(tmp, target)
  const d = await fs.open(dir, 'r')
  try {
    await d.sync()
  } catch {
    /* dir fsync unsupported on some platforms */
  } finally {
    await d.close()
  }
}

const worker = async (id) => {
  const dir = await mkdtemp(join(tmpdir(), `fsync-probe-${id}-`))
  const times = []
  for (let i = 0; i < WRITES; i++) {
    const t0 = process.hrtime.bigint()
    await atomicWrite(dir, i)
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  await fs.rm(dir, { recursive: true, force: true })
  return times
}

const all = (await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)))).flat()
all.sort((a, b) => a - b)
const at = (p) => all[Math.min(all.length - 1, Math.floor((p / 100) * all.length))].toFixed(1)
console.log(`${WORKERS} workers x ${WRITES} atomic writes = ${all.length} samples`)
console.log(`p50=${at(50)}ms  p95=${at(95)}ms  p99=${at(99)}ms  MAX=${all[all.length - 1].toFixed(1)}ms`)
console.log(`samples over 1000ms: ${all.filter((t) => t > 1000).length}`)
console.log(`samples over 5000ms: ${all.filter((t) => t > 5000).length}`)
