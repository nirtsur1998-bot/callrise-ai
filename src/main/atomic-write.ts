import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Write a JSON record to disk ATOMICALLY. Serializes `value`, writes it to a
 * unique temp file, parses it back to confirm the bytes landed intact, then
 * renames it over the target. `rename` is atomic on the same filesystem, so an
 * interrupted write (crash / power loss) leaves either the PREVIOUS complete
 * file or the new complete one — never a truncated file that the record readers
 * silently skip (which would be silent data loss).
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
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {}) // never leave a partial temp behind
    throw err
  }
}
