// BUG-210 / BUG-213 — every SECURITY DEFINER function must have an explicit
// revoke from PUBLIC.
//
// Postgres grants EXECUTE on every new function to PUBLIC by default, and
// `security definer` makes the function run with the OWNER's rights, ignoring
// row-level security. So a definer function with no explicit revoke is
// callable by anyone who can reach PostgREST — including a holder of the anon
// key, which is embedded in the shipped desktop app.
//
// BUG-213 IS LIVE, and it is the reason this file parses rather than checks a
// list. The existing revoke for telemetry_prune reads:
//
//     revoke all on function public.telemetry_prune() from anon, authenticated;
//
// which removes nothing, because both roles inherit EXECUTE from PUBLIC.
// Measured against the deployed project with the anon key and no session:
//
//     GET /rest/v1/rpc/telemetry_prune
//     -> 405 {"code":"25006","message":"cannot execute SELECT in a read-only
//             transaction"}
//
// That is Postgres refusing to run the function's DELETE inside PostgREST's
// read-only GET transaction — the permission check had already passed. A POST
// would have run it.
//
// Twelve lines earlier in the SAME FILE, telemetry_ingest_batch is revoked
// `from public` correctly. So this is not a misunderstanding, it is a slip in
// one of two adjacent statements — precisely the kind a human reviewer reads
// straight past, and precisely what a parser does not.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUPABASE = join(__dirname, '..', '..', 'supabase')

const FILES = readdirSync(SUPABASE)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ name: f, sql: readFileSync(join(SUPABASE, f), 'utf8') }))

const ALL_SQL = FILES.map((f) => f.sql).join('\n')

interface Fn {
  name: string
  file: string
  definer: boolean
}

/** Every function definition in the tree, with whether it is SECURITY DEFINER.
 *  The body is taken as everything up to the `as $$`, which is where the
 *  modifiers live. */
function functions(): Fn[] {
  const out: Fn[] = []
  for (const { name: file, sql } of FILES) {
    const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi
    for (const m of sql.matchAll(re)) {
      const head = sql.slice(m.index, sql.indexOf('$$', m.index))
      out.push({ name: m[1], file, definer: /security\s+definer/i.test(head) })
    }
  }
  return out
}

/** A revoke can also be issued from a LOOP, which is how the alerts functions
 *  are handled: their signatures sit in a text[] and the revoke is
 *  `execute format('revoke all on function %s from public, anon, ...', fn)`.
 *
 *  That form is not optional dressing. The alerts objects do not exist on the
 *  project yet, and a bare revoke against a missing function aborts the whole
 *  script — which would have left the LIVE telemetry fix looking applied while
 *  the run reported an error. So the loop, with an existence check, is the
 *  correct shape and this guard has to understand it.
 *
 *  A function counts as covered by a loop when its quoted signature appears in
 *  a file that also contains a templated revoke naming PUBLIC. That is looser
 *  than the literal case, deliberately: the alternative is a guard that
 *  demands the dangerous form. */
function revokedByLoop(fnName: string): boolean {
  return FILES.some(
    (f) =>
      /revoke\s+all\s+on\s+function\s+%s\s+from\s+[^']*\bpublic\b/i.test(f.sql) &&
      new RegExp(String.raw`'public\.${fnName}\s*\(`).test(f.sql)
  )
}

/** True when SOMETHING in the supabase tree revokes this function from PUBLIC.
 *  Deliberately loose about the argument list — matching signatures exactly is
 *  Postgres's job and it errors loudly on a mismatch, whereas a missing
 *  `public` in the from-list is the silent failure this test exists for. */
function revokedFromPublic(fnName: string): boolean {
  if (revokedByLoop(fnName)) return true
  const re = new RegExp(
    String.raw`revoke\s+[\s\S]{0,40}?on\s+function\s+public\.${fnName}\s*\([^)]*\)\s*from\s+([^;]+);`,
    'i'
  )
  // EVERY match, not the first. A function can be revoked more than once —
  // 2026-09-revoke-definer-functions.sql exists precisely to CORRECT an
  // earlier incomplete revoke — and reading only the first match reported a
  // function as still broken after it had been fixed, because the older,
  // weaker revoke sorts earlier by filename. Found by this test failing on its
  // own subject minutes after the fix was written.
  const matches = [...ALL_SQL.matchAll(new RegExp(re.source, 'gi'))]
  return matches.some((m) => /\bpublic\b/i.test(m[1]))
}

describe('every SECURITY DEFINER function is revoked from PUBLIC', () => {
  const all = functions()

  it('the parser finds functions at all — otherwise this guard is vacuous', () => {
    // Without this, a change to how functions are declared turns the whole
    // file green while checking nothing.
    expect(all.length, 'no function definitions were parsed out of supabase/*.sql').toBeGreaterThan(8)
    expect(
      all.filter((f) => f.definer).length,
      'no SECURITY DEFINER functions were detected — the modifier test is broken'
    ).toBeGreaterThan(5)
  })

  it('THE CHECK: no definer function relies on the default PUBLIC grant', () => {
    const unprotected = all
      .filter((f) => f.definer)
      .filter((f) => !revokedFromPublic(f.name))
      .map((f) => `${f.file}: public.${f.name}()`)

    expect(
      unprotected,
      'these SECURITY DEFINER functions have no revoke that names PUBLIC, so Postgres\'s ' +
        'default grant leaves them callable by anyone holding the shipped anon key:\n  ' +
        unprotected.join('\n  ') +
        '\n\nAdd `revoke all on function public.<name>(<args>) from public, anon, authenticated;` ' +
        'and then grant back only the role that needs it. Revoking from anon alone removes ' +
        'NOTHING, because anon inherits EXECUTE from PUBLIC — that is BUG-213.'
    ).toEqual([])
  })

  it('a revoke that names only anon or authenticated does not count', () => {
    // The specific shape of BUG-213, pinned so the fix cannot regress into the
    // form that looks right and does nothing. Checked against the parser
    // itself rather than against a file, so it stays true if the files move.
    const onlyRoles = 'revoke all on function public.some_fn() from anon, authenticated;'
    const withPublic = 'revoke all on function public.some_fn() from public, anon;'
    const from = (sql: string): string =>
      /from\s+([^;]+);/.exec(sql)?.[1] ?? ''
    expect(/\bpublic\b/i.test(from(onlyRoles)), 'a revoke naming only roles must NOT count').toBe(
      false
    )
    expect(/\bpublic\b/i.test(from(withPublic))).toBe(true)
  })

  it('the looped revoke names PUBLIC too, or the loop protects nothing', () => {
    // The loop form is only as good as its template. `from anon, authenticated`
    // inside a format() string is the same no-op as BUG-213, just harder to
    // see, so the template is pinned separately from the signatures it applies
    // to.
    const looped = FILES.filter((f) => /revoke\s+all\s+on\s+function\s+%s/i.test(f.sql))
    expect(looped.length, 'no templated revoke found — this check has nothing to guard').toBeGreaterThan(0)
    for (const f of looped) {
      const templates = [...f.sql.matchAll(/revoke\s+all\s+on\s+function\s+%s\s+from\s+([^'\n]+)/gi)]
      for (const t of templates) {
        expect(
          /\bpublic\b/i.test(t[1]),
          `${f.name}: a templated revoke reads "from ${t[1].trim()}" — without PUBLIC it removes ` +
            'nothing, because anon and authenticated inherit EXECUTE from PUBLIC'
        ).toBe(true)
      }
    }
  })

  it('names the live instance explicitly, so fixing it cannot be quiet', () => {
    // BUG-213 is the one that was reachable on the deployed project. It gets
    // its own line so that "the suite is green" and "telemetry_prune is locked
    // down" are the same statement rather than two.
    expect(
      revokedFromPublic('telemetry_prune'),
      'telemetry_prune is SECURITY DEFINER, deletes rows, and was measured reachable by anon ' +
        'on the live project. Its revoke must name PUBLIC.'
    ).toBe(true)
  })
})
