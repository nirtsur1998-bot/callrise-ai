// M39 §8 — DRIVE, not a fixture test: build the dossier for a contact on a
// records sandbox THROUGH THE PRODUCT'S OWN ENTRY (`ensureDossier`, the call
// live-cue makes), and print "Known facts" as of now and as of an earlier
// moment. Runs only when CALLRISE_SANDBOX_DIR and CALLRISE_DRIVE_CONTACT name
// a profile and a contact; skipped everywhere else (CI, other machines).
import { describe, expect, it } from 'vitest'

const SANDBOX = process.env.CALLRISE_SANDBOX_DIR
const CONTACT = process.env.CALLRISE_DRIVE_CONTACT
const AS_OF = process.env.CALLRISE_DRIVE_AS_OF // optional second moment
const OUT = process.env.CALLRISE_DRIVE_OUT // where to write the rendered text (the reporter may swallow console output)

describe.runIf(!!SANDBOX && !!CONTACT)('M39 §8 — dossier driven on a sandbox profile', () => {
  it('renders Known facts through ensureDossier, dated', async () => {
    const { appendFile, writeFile } = await import('node:fs/promises')
    const emit = async (s: string): Promise<void> => {
      console.log(s)
      if (OUT) await appendFile(OUT, s + '\n')
    }
    if (OUT) await writeFile(OUT, '')
    const { ensureDossier } = await import('../dossier-store')
    const now = await ensureDossier(SANDBOX!, `drive-${Date.now()}`, CONTACT!)
    await emit('=== DOSSIER as of now ===\n' + now)
    expect(now).toContain('Known facts:')
    if (AS_OF) {
      // `ensureDossier` freezes asOf at the moment it runs; to see an earlier
      // moment, build once more with the same records at that instant.
      const { buildClientDossier } = await import('../clientDossier')
      const { readFile, readdir } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const read = async <T>(dir: string): Promise<T[]> =>
        Promise.all(
          (await readdir(join(SANDBOX!, dir)))
            .filter((f) => f.endsWith('.json'))
            .map(async (f) => JSON.parse(await readFile(join(SANDBOX!, dir, f), 'utf8')) as T)
        )
      const contacts = await read<{ id: string }>('contacts')
      const contact = contacts.find((c) => c.id === CONTACT) as never
      const then = buildClientDossier({ contact, calls: [], tasks: [], asOf: AS_OF }).text
      await emit(`=== DOSSIER as of ${AS_OF} ===\n` + then)
    }
  })
})
