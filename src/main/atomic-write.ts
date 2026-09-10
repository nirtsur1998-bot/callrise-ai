import { promises as fs } from 'node:fs'
import {
  writeFileSync,
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * Write a JSON record to disk ATOMICALLY and DURABLY. Serializes `value`,
 * writes it to a unique temp file, parses it back to confirm the bytes landed
 * intact, fsyncs the temp file, renames it over the target, then fsyncs the
 * parent directory. `rename` is atomic on the same filesystem, so an
 * interrupted write (crash / power loss) leaves either the PREVIOUS complete
 * file or the new complete one — never a truncated file that the record readers
 * silently skip (which would be silent data loss). The fsyncs flush the data
 * and the directory entry out of the OS page cache, so the guarantee holds
 * across real power loss / kernel panic, not just app crashes.
 *
 * The temp name carries a random suffix so two concurrent writers to the same
 * record can't clobber each other's temp file, and it does NOT end in `.json`
 * so a leftover temp (after a crash) is ignored by the `.json`-only directory
 * listings.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value, null, 2)
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, data, 'utf8')
    JSON.parse(await fs.readFile(tmp, 'utf8')) // verify it's complete before it replaces the good file
    // 'r+' (not 'r'): Windows refuses to fsync a handle that lacks write
    // access, unlike macOS/Linux where any valid fd can be flushed.
    const tmpHandle = await fs.open(tmp, 'r+')
    try {
      await tmpHandle.sync() // flush the data to disk before the rename makes it live
    } finally {
      await tmpHandle.close()
    }
    await fs.rename(tmp, path)
    // Windows can't open a directory as a file handle (unlike macOS/Linux),
    // so this extra directory-fsync is POSIX-only; NTFS's own journaling
    // already makes the rename durable there without it.
    if (process.platform !== 'win32') {
      const dirHandle = await fs.open(dirname(path), 'r')
      try {
        await dirHandle.sync() // flush the directory entry so the rename survives power loss
      } finally {
        await dirHandle.close()
      }
    }
  } catch (err) {
    await fs.unlink(tmp).catch(() => {}) // never leave a partial temp behind
    throw err
  }
}

/**
 * Windows error codes that mean "someone else is holding this file right now",
 * not "this write is impossible".
 *
 * BUG-244 — on the founder's own machine, under load, `writeJsonAtomic`'s
 * rename failed with EPERM and its temp file went missing with ENOENT. On
 * Windows a rename over an existing file fails with EPERM/EACCES while any
 * other process holds a handle on either side, and a real-time scanner opens
 * files microseconds after they are created. These are transient by nature:
 * the same write succeeds moments later.
 */
const CONTENDED_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT'])

/**
 * `writeJsonAtomic` with a bounded retry on transient Windows contention.
 *
 * DELIBERATELY OPT-IN, one caller at a time. BUG-244's own closing note is
 * *"enumerate what each `writeJsonAtomic` caller does when it rejects, and
 * decide per caller between retry-with-backoff, surface-to-the-user, and
 * log-and-continue"* — so this does not silently change behaviour for the
 * dozen existing callers. It is for the writes where a dropped write is not a
 * stale cache but a broken promise.
 *
 * BOUNDED on purpose: ~375 ms total. An unbounded wait would manufacture
 * exactly the stall BUG-141 is about. If every attempt fails it THROWS — the
 * caller is expected to do something visible with that, which is the whole
 * point of using this instead of the plain version.
 */
export async function writeJsonAtomicDurable(path: string, value: unknown): Promise<void> {
  const backoffMs = [25, 50, 100, 200]
  for (let attempt = 0; ; attempt++) {
    try {
      await writeJsonAtomic(path, value)
      return
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      const retryable = typeof code === 'string' && CONTENDED_WRITE_CODES.has(code)
      if (!retryable || attempt >= backoffMs.length) throw err
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]))
    }
  }
}

/**
 * Synchronous variant of writeJsonAtomic, for stores that must stay
 * synchronous (app-settings.ts's loopback-gate check reads in the same tick).
 * Same guarantee: a crash mid-write leaves the previous complete file, never
 * a truncated one that readers silently replace with defaults.
 */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  const data = JSON.stringify(value)
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, data, 'utf8')
    JSON.parse(readFileSync(tmp, 'utf8')) // verify before it replaces the good file
    // 'r+' (not 'r'): Windows refuses to fsync a handle that lacks write
    // access, unlike macOS/Linux where any valid fd can be flushed.
    let fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    if (process.platform !== 'win32') {
      fd = openSync(dirname(path), 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* never leave a partial temp behind */
    }
    throw err
  }
}
