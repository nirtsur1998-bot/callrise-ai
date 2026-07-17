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
