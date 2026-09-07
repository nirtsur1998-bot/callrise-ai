// BUG-204 — a scrub must prove the data is GONE, not merely that no error came
// back.
//
// THE MEASUREMENT THIS FILE EXISTS FOR, taken against the live Supabase
// project on 2026-09-07, on three separate tables:
//
//     DELETE ... where user_id = <someone else's id>
//     -> HTTP 200, body [], error null
//
// That is byte-identical to a DELETE that removed every row. The old check was
// `if (error) throw`, so it could not tell "deleted everything" from "deleted
// nothing because a policy filtered it". It then cleared the key from the
// pending queue and the Backup card reported an erase that never happened.
//
// The old code was correct only by accident: before 2026-09-erase-paths.sql the
// one table we happened to hit ALSO lacked the DELETE grant, and a missing
// grant does raise an error. Any table with the grant and no policy would have
// scrubbed silently and successfully while deleting nothing.
//
// These tests drive the real functions with a stub client, so each one fails if
// the logic is wrong rather than if a comment changes. The stub is deliberately
// dumb: it returns exactly what PostgREST and storage-js return, including the
// shapes that carry no error.
import { describe, expect, it } from 'vitest'
import { eraseUserRowsProven, eraseStoragePrefixProven, ScrubError } from '../backup'

const USER = 'u-1'

/** A stub PostgREST client. `counts` is the sequence of counts the two
 *  count-reads return, in order; `deleted` is what the DELETE reports. */
function tableClient(opts: {
  counts: (number | null)[]
  deleted: number | null
  deleteError?: string
  countError?: string
}): never {
  let call = 0
  const client = {
    from() {
      return {
        select() {
          return {
            eq: async () => {
              const n = opts.counts[Math.min(call++, opts.counts.length - 1)]
              return opts.countError
                ? { count: null, error: { message: opts.countError } }
                : { count: n, error: null }
            }
          }
        },
        delete() {
          return {
            eq: async () =>
              opts.deleteError
                ? { count: null, error: { message: opts.deleteError } }
                : { count: opts.deleted, error: null }
          }
        }
      }
    }
  }
  return client as never
}

/** A stub Storage client. `pages` is what successive list() calls return;
 *  `removed` is what each remove() reports it deleted. */
function storageClient(opts: {
  pages: { name: string }[][]
  removed: number[]
  removeError?: string
  listError?: string
}): never {
  let listCall = 0
  let removeCall = 0
  const client = {
    storage: {
      from() {
        return {
          list: async () => {
            if (opts.listError) return { data: null, error: { message: opts.listError } }
            const page = opts.pages[listCall++] ?? []
            return { data: page, error: null }
          },
          remove: async () => {
            if (opts.removeError) return { data: null, error: { message: opts.removeError } }
            const n = opts.removed[removeCall++] ?? 0
            return { data: Array.from({ length: n }, (_, i) => ({ name: `x${i}` })), error: null }
          }
        }
      }
    }
  }
  return client as never
}

describe('a table scrub proves the rows are gone', () => {
  it('THE BUG: a delete that reports 0 affected rows and leaves rows behind is a FAILURE', async () => {
    // This is the exact shape measured on the live project: no error, no rows
    // deleted, rows still there. The old code called this success.
    const client = tableClient({ counts: [5, 5], deleted: 0 })
    await expect(eraseUserRowsProven(client, 'backup_knowledge', USER)).rejects.toThrow(
      /policy filtered it/
    )
    await expect(eraseUserRowsProven(client, 'backup_knowledge', USER)).rejects.toMatchObject({
      code: 'survivors'
    })
  })

  it('a normal erase passes', async () => {
    const client = tableClient({ counts: [5, 0], deleted: 5 })
    await expect(eraseUserRowsProven(client, 'backup_knowledge', USER)).resolves.toBe('erased')
  })

  it('ALREADY EMPTY is a success, not a failure — and this is the common case', async () => {
    // The founder's first instruction was "fail if the count did not move".
    // Taken literally this case fails forever, and for the `transcripts` key
    // that means touchAllCallsForRepush rewriting and re-uploading the user's
    // ENTIRE call history on every push. The rule is `after === 0`, not
    // "moved", and this test is what pins the difference.
    const client = tableClient({ counts: [0, 0], deleted: 0 })
    await expect(eraseUserRowsProven(client, 'backup_knowledge', USER)).resolves.toBe(
      'already-empty'
    )
  })

  it('after === 0 is STRONGER than "the count moved": 5 -> 2 is not erased', async () => {
    const client = tableClient({ counts: [5, 2], deleted: 3 })
    await expect(eraseUserRowsProven(client, 'backup_knowledge', USER)).rejects.toMatchObject({
      code: 're-added'
    })
  })

  it('a count that cannot be READ is unverifiable, never zero', async () => {
    // The dangerous default. A missing count header parsed as 0 would report a
    // successful erase on no evidence at all.
    const client = tableClient({ counts: [null, null], deleted: 1, countError: 'no header' })
    await expect(eraseUserRowsProven(client, 'backup_knowledge', USER)).rejects.toMatchObject({
      code: 'unverifiable'
    })
  })

  it('a real delete error still surfaces, with its own code', async () => {
    const client = tableClient({ counts: [1, 1], deleted: null, deleteError: 'permission denied' })
    await expect(eraseUserRowsProven(client, 'backup_knowledge', USER)).rejects.toMatchObject({
      code: 'delete-error'
    })
  })

  it('every thrown code is safe for reportBackupStep to forward', async () => {
    // reportBackupStep only passes through values matching this pattern; a code
    // it rejects would be dropped and BUG-203's telemetry would go quiet again.
    const SAFE = /^[A-Za-z0-9_.-]{1,64}$/
    const cases: [Parameters<typeof tableClient>[0], string][] = [
      [{ counts: [5, 5], deleted: 0 }, 'survivors'],
      [{ counts: [5, 2], deleted: 3 }, 're-added'],
      [{ counts: [null, null], deleted: 1, countError: 'x' }, 'unverifiable'],
      [{ counts: [1, 1], deleted: null, deleteError: 'x' }, 'delete-error']
    ]
    for (const [opts, expected] of cases) {
      const err = await eraseUserRowsProven(tableClient(opts), 't', USER).catch((e) => e)
      expect(err).toBeInstanceOf(ScrubError)
      expect(err.code).toBe(expected)
      expect(SAFE.test(`scrub.salesBrain`)).toBe(true)
      expect(SAFE.test(err.code)).toBe(true)
    }
  })
})

describe('a storage scrub proves the prefix is empty', () => {
  it('THE STORAGE TWIN OF THE BUG: remove reports nothing removed and the objects are still there', async () => {
    // storage-js needs BOTH delete and select on storage.objects. A bucket with
    // a delete policy and a broken select policy returns 200 with data: [] and
    // no error — the same shape as a full erase.
    const client = storageClient({
      pages: [[{ name: 'memory.db' }], [{ name: 'memory.db' }]],
      removed: [0]
    })
    await expect(eraseStoragePrefixProven(client, 'sales-brain', USER)).rejects.toMatchObject({
      code: 'survivors'
    })
  })

  it('a normal erase passes, and the CONFIRMING list is what proves it', async () => {
    // Page 1 has the object, the remove takes it, the confirming list is empty.
    // The old loop broke out immediately after the remove and never re-listed,
    // so it could not have distinguished this from the case above.
    const client = storageClient({ pages: [[{ name: 'memory.db' }], []], removed: [1] })
    await expect(eraseStoragePrefixProven(client, 'sales-brain', USER)).resolves.toBe('erased')
  })

  it('an empty prefix is already-empty, not a failure', async () => {
    const client = storageClient({ pages: [[], []], removed: [] })
    await expect(eraseStoragePrefixProven(client, 'sales-brain', USER)).resolves.toBe(
      'already-empty'
    )
  })

  it('a full page that removes nothing does not spin forever', async () => {
    // The old loop only broke when a page was short or empty. A page of 100
    // that removes nothing would have looped for ever; this asserts it stops
    // and reports instead. Without the guard this test hangs rather than fails,
    // which is why the page is deliberately full.
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `o${i}` }))
    const client = storageClient({ pages: [full, full, full], removed: [0, 0, 0] })
    await expect(eraseStoragePrefixProven(client, 'attachments', USER)).rejects.toMatchObject({
      code: 'survivors'
    })
  })

  it('a list that fails after removing is unverifiable, not success', async () => {
    const client = storageClient({ pages: [[{ name: 'a' }]], removed: [1], listError: undefined })
    // second list returns [] here, so this one passes; the unverifiable path is
    // covered by the error branch below.
    await expect(eraseStoragePrefixProven(client, 'attachments', USER)).resolves.toBe('erased')
    const broken = storageClient({ pages: [[]], removed: [], listError: 'network' })
    await expect(eraseStoragePrefixProven(broken, 'attachments', USER)).rejects.toMatchObject({
      code: 'list-error'
    })
  })
})
