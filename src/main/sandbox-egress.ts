/**
 * BUG-263 — the sandbox flag gated the cloud backup and NOTHING else.
 *
 * WHAT HAPPENED. A sandbox profile printed BUG-186's two guard lines — *"cloud
 * backup push and pull REFUSED"* — and was treated as isolated. It then created
 * three fictional meetings, two of which were inserted into the founder's real
 * Outlook calendar within seconds. The guard was not failing at its job: its job
 * was two functions wide (`pushAll`, `pullAll`) and every reader, including the
 * person who wrote the drive, assumed it meant "this copy cannot reach
 * anything". Ten egress paths existed; one was gated.
 *
 * Taxonomy species 8, "enumerate the container the CLAIM names": proving
 * cloud-backup isolation, thoroughly and correctly, while the calendar wrote
 * to a real mailbox.
 *
 * THE FIX THE FOUNDER ASKED FOR, in their words: *"gate every egress path, and
 * enumerate them so we know what 'every' means."* So this is a DEFAULT-DENY
 * choke point rather than another list of call-site checks — a new integration
 * is refused because nobody allowed it, not permitted because nobody remembered
 * it. The enumeration below is what "every" means, and the tests hold it to it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT COVER, stated up front because an isolation guard that
 * overstates itself is the bug it is fixing:
 *
 *   1. It patches `globalThis.fetch` and node's `http`/`https` request
 *      functions. Anything that captured a reference to either BEFORE
 *      `installSandboxEgressGuard` ran holds the original and is not gated.
 *      Which libraries do that is an empirical question, not a reasoning one:
 *      `scripts/verification/bug263-egress-canary.mjs` drives every path through
 *      its real client and counts what escapes. Measured 2026-09-11: 6 of 6
 *      gated, 0 escaped — including `ws`, whose Deepgram socket is caught
 *      indirectly through its `https.request` upgrade handshake. Whatever
 *      escapes gets a call-site gate, and the tracker row says which kind of
 *      gate caught it.
 *   2. It does not cover the RENDERER. Renderer traffic goes through Chromium,
 *      not node — `session.defaultSession.webRequest` is where that would be
 *      intercepted. Today every path in the enumeration originates in main;
 *      `sandbox-egress.enumeration.test.ts` fails if a `fetch(` or
 *      `new WebSocket` appears in renderer source, so this stays true or
 *      somebody finds out.
 *   3. It does not cover native brokers. Outlook's WAM sign-in is a Windows
 *      broker call, not HTTP, and cannot be refused here. The
 *      `graph.microsoft.com` calls it enables afterwards CAN be, and are.
 *   4. It is DEV-ONLY. `markSandboxProfile` is only handed a directory when
 *      `CALLRISE_USER_DATA_DIR` is set, which `index.ts` refuses to read in a
 *      packaged build. A real user's process is byte-for-byte unpatched;
 *      `sandbox-egress.packaged.test.ts` pins that.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ClientRequest, RequestOptions } from 'node:http'

/**
 * The enumeration. One row per thing that can leave the machine, named after
 * what the USER would lose or notice — not after the module that sends it.
 *
 * `auth` and `local` have no opt-out because refusing them breaks the sandbox
 * rather than protecting anything: a copy that cannot sign in cannot be driven
 * at all, and BUG-186's decision was explicitly that auth stays reachable so a
 * copy can stay signed in. Everything else is off unless asked for.
 */
export type EgressCategory =
  /** Supabase `/auth/` — sign-in only. Always allowed, deliberately (BUG-186). */
  | 'auth'
  /** Loopback and non-network schemes: the dev server, CDP, file:, data:. */
  | 'local'
  /** Supabase rows, storage, edge functions: records, attachments, scrub
   *  DELETEs, verification and alert EMAILS to real inboxes. */
  | 'sync'
  /** Google Calendar and Microsoft Graph: events created, edited and deleted in
   *  a calendar the user can see. This is the one that bit us. */
  | 'calendar'
  /** Deepgram: live call audio. */
  | 'transcription'
  /** Any model provider: transcripts, prompts, and — since M39 — the client
   *  dossier, which carries a buyer's verbatim quotes from EARLIER calls. */
  | 'ai'
  /** Telegram and WhatsApp: messages into real chats belonging to real people. */
  | 'alerts'
  /** Not in the enumeration. Refused, and the refusal names the host so the
   *  next integration gets a row here instead of a surprise. */
  | 'unknown'

/** Categories a sandbox may be granted. `auth`/`local` are not grantable
 *  because they are never refused; `unknown` is not grantable because granting
 *  "everything I forgot to enumerate" is the bug. */
export const GRANTABLE: readonly EgressCategory[] = [
  'sync',
  'calendar',
  'transcription',
  'ai',
  'alerts'
]

export interface EgressDecision {
  category: EgressCategory
  allowed: boolean
  /** Host as classified, for the log line. '' when the URL could not be parsed. */
  host: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * Host → category. Suffix matches, so `abcd.supabase.co` and
 * `login.microsoftonline.com` are covered without listing every project.
 *
 * AI hosts are NOT exhaustive and cannot be: `openai-compatible.ts` takes a
 * `baseURL` from configuration, so a provider can be added without touching
 * this file. That is the correct behaviour — an unlisted host is refused as
 * `unknown` rather than quietly permitted — and
 * `sandbox-egress.enumeration.test.ts` reads every `baseURL:` literal out of
 * `ai/registry.ts` and fails if one of them does not classify as `ai`. The
 * list below is therefore a convenience that is TESTED against its source,
 * never a second copy of it.
 */
const HOSTS: ReadonlyArray<readonly [suffix: string, category: EgressCategory]> = [
  // calendar — providers and the token endpoints that unlock them. Refusing
  // the token endpoint refuses calendar access at the root, which is the point.
  ['graph.microsoft.com', 'calendar'],
  ['login.microsoftonline.com', 'calendar'],
  ['oauth2.googleapis.com', 'calendar'],
  ['accounts.google.com', 'calendar'],
  ['www.googleapis.com', 'calendar'],
  // transcription
  ['api.deepgram.com', 'transcription'],
  // ai
  ['api.anthropic.com', 'ai'],
  ['api.openai.com', 'ai'],
  ['api.groq.com', 'ai'],
  ['generativelanguage.googleapis.com', 'ai'],
  ['openrouter.ai', 'ai'],
  ['integrate.api.nvidia.com', 'ai'],
  ['api.cerebras.ai', 'ai'],
  ['api.z.ai', 'ai'],
  ['router.huggingface.co', 'ai'],
  ['api.cloudflare.com', 'ai'],
  ['api.mistral.ai', 'ai'],
  // alerts
  ['api.telegram.org', 'alerts'],
  ['graph.facebook.com', 'alerts']
]

function hostMatches(host: string, suffix: string): boolean {
  // Suffix match on a LABEL boundary. A plain `endsWith` would classify
  // `evil-api.z.ai.attacker.com` — or, more realistically, `notgraph.facebook.com`
  // — by accident.
  return host === suffix || host.endsWith(`.${suffix}`)
}

/**
 * Pure. Given a URL and the granted categories, should this request leave?
 *
 * Every branch that cannot determine an answer returns REFUSED. A guard whose
 * unknown case is "allow" is a guard that is off for everything it did not
 * anticipate, which is the whole of BUG-263.
 */
export function classifyEgress(
  rawUrl: string,
  granted: ReadonlySet<string> = new Set()
): EgressDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { category: 'unknown', allowed: false, host: '' }
  }

  // Non-network schemes are not egress: file:, data:, blob:, devtools:.
  if (!/^(https?|wss?):$/.test(url.protocol)) {
    return { category: 'local', allowed: true, host: url.hostname }
  }

  const host = url.hostname.toLowerCase()
  if (LOOPBACK.has(host) || host.endsWith('.localhost')) {
    return { category: 'local', allowed: true, host }
  }

  // Supabase splits by PATH, not host: the same project serves sign-in and the
  // user's records. Auth stays open so a copy can stay signed in; /rest/,
  // /storage/ and /functions/ are the records, the files and the emails.
  if (hostMatches(host, 'supabase.co') || hostMatches(host, 'supabase.in')) {
    const category: EgressCategory = url.pathname.startsWith('/auth/') ? 'auth' : 'sync'
    return { category, allowed: category === 'auth' || granted.has('sync'), host }
  }

  for (const [suffix, category] of HOSTS) {
    if (hostMatches(host, suffix)) {
      return { category, allowed: granted.has(category), host }
    }
  }

  return { category: 'unknown', allowed: false, host }
}

/** Parse `CALLRISE_SANDBOX_ALLOW`. `all` grants every grantable category —
 *  an explicit escape hatch, so "I meant to" is distinguishable from
 *  "I forgot to". Unknown names are ignored rather than throwing: a typo
 *  should fail CLOSED (nothing granted), never take the app down. */
export function parseGranted(raw: string | undefined, legacyAllowSync: boolean): Set<string> {
  const out = new Set<string>()
  if (legacyAllowSync) out.add('sync')
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim().toLowerCase()
    if (!name) continue
    if (name === 'all') {
      for (const c of GRANTABLE) out.add(c)
      continue
    }
    if ((GRANTABLE as readonly string[]).includes(name)) out.add(name)
  }
  return out
}

/** Every refusal, counted. A test that asserts "nothing reached the calendar"
 *  needs the companion work count, or it cannot tell a working guard from a
 *  code path that never ran (species: a pass over zero executions). */
const refusals: { category: EgressCategory; host: string; url: string }[] = []
export function sandboxRefusals(): ReadonlyArray<{
  category: EgressCategory
  host: string
  url: string
}> {
  return refusals
}

export class SandboxEgressRefused extends Error {
  readonly category: EgressCategory
  readonly host: string
  constructor(decision: EgressDecision, url: string) {
    super(
      `[dev] SANDBOX egress REFUSED (${decision.category}) ${decision.host || url} — ` +
        `this profile is a sandbox. Allow it with CALLRISE_SANDBOX_ALLOW=${decision.category}`
    )
    this.name = 'SandboxEgressRefused'
    this.category = decision.category
    this.host = decision.host
  }
}

function refuse(decision: EgressDecision, url: string): SandboxEgressRefused {
  refusals.push({ category: decision.category, host: decision.host, url })
  const err = new SandboxEgressRefused(decision, url)
  // One searchable line per refusal. A silently refused Deepgram socket looks
  // exactly like broken transcription, and somebody will spend an hour on it.
  console.error(err.message)
  return err
}

/** Resolve the URL a node http/https call is about to make. The overloads
 *  accept (url), (url, options), (options) — and `options` may carry host,
 *  hostname, port, path and protocol separately. */
function urlFromNodeArgs(args: unknown[], defaultProtocol: string): string {
  const first = args[0]
  if (typeof first === 'string') return first
  if (first instanceof URL) return first.toString()
  const o = (first ?? {}) as RequestOptions & { href?: string }
  if (typeof o.href === 'string') return o.href
  const protocol = o.protocol ?? defaultProtocol
  const host = o.hostname ?? o.host ?? ''
  const port = o.port ? `:${o.port}` : ''
  const path = o.path ?? '/'
  return `${protocol}//${host}${port}${path}`
}

let installed = false
/** Held at module scope so `resetSandboxEgressForTests` can actually UNDO the
 *  patch. An earlier version only flipped `installed` back to false, which left
 *  the patched `fetch` in place and let the next install wrap the wrapper —
 *  a test-only landmine, but in a module whose entire job is to be trusted. */
let uninstall: (() => void) | null = null

/**
 * Install the guard. Returns an uninstall function (tests only — nothing in
 * the app removes it).
 *
 * ORDER MATTERS AND IS NOT FULLY IN OUR CONTROL. Under ESM/CJS both, this runs
 * after every statically imported module body in the graph. A client that
 * captured `globalThis.fetch` at module scope is holding the pre-patch
 * function. That is why the canary exists.
 */
export function installSandboxEgressGuard(granted: ReadonlySet<string>): () => void {
  if (installed) return () => undefined
  installed = true

  const realFetch = globalThis.fetch
  const gatedFetch: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const decision = classifyEgress(url, granted)
    if (!decision.allowed) return Promise.reject(refuse(decision, url))
    return realFetch(input, init)
  }
  globalThis.fetch = gatedFetch

  // node http/https. `ws` performs its upgrade handshake through
  // https.request, so gating here gates the Deepgram socket too — verified by
  // the canary rather than assumed from the docs.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const patched: { mod: any; key: string; real: any }[] = []
  for (const [modName, proto] of [
    ['node:http', 'http:'],
    ['node:https', 'https:']
  ] as const) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(modName)
    for (const key of ['request', 'get']) {
      const real = mod[key]
      patched.push({ mod, key, real })
      mod[key] = (...args: unknown[]): ClientRequest => {
        const url = urlFromNodeArgs(args, proto)
        const decision = classifyEgress(url, granted)
        if (!decision.allowed) throw refuse(decision, url)
        return real(...args)
      }
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  uninstall = () => {
    globalThis.fetch = realFetch
    for (const { mod, key, real } of patched) mod[key] = real
    installed = false
    uninstall = null
    refusals.length = 0
  }
  return uninstall
}

/** The launch line: what this sandbox can and cannot reach, in one place, so a
 *  reader never again has to infer "isolated" from a line about backups. */
export function describeSandboxEgress(granted: ReadonlySet<string>): string {
  const allowed = GRANTABLE.filter((c) => granted.has(c))
  const refused = GRANTABLE.filter((c) => !granted.has(c))
  return (
    `[dev] SANDBOX egress gate ON — refused: ${refused.join(', ') || 'none'}` +
    ` | allowed: ${['auth', 'local', ...allowed].join(', ')}` +
    ` | unlisted hosts are REFUSED. Grant with CALLRISE_SANDBOX_ALLOW=<category,...|all>`
  )
}

/** Tests only. Genuinely removes the patch — see `uninstall` above for why
 *  "set the flag back" was not good enough. */
export function resetSandboxEgressForTests(): void {
  uninstall?.()
  refusals.length = 0
  installed = false
}
