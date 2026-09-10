/**
 * M39 Stage 4, feature #1 — objection pre-loading.
 *
 * The founder's sentence for it: *"She raised budget on the last two calls.
 * Before pricing comes up, have the ROI reframe ready — the one that worked
 * last time, with her."*
 *
 * MEASURED BEFORE IT WAS WRITTEN, because a feature nothing can feed is worse
 * than one that does not exist. On the founder's own profile the objection
 * queue holds **287 mined objections**, every one carrying a `callId`, a
 * `type`, the buyer's `objectionQuote`, the rep's `responseQuote`, and —
 * decisively for this feature — `recoveredWell`, split almost evenly at
 * 145 true / 142 false. So "the one that worked last time" is not a guess we
 * have to make: it is a field.
 *
 * `other` IS EXCLUDED, and that is the one judgement call here. 108 of the 287
 * are typed `other`, which is the model's way of saying it could not classify
 * the objection — the same shape as the absence answers `isNonName` refuses,
 * and for the same reason: "they raised OTHER on the last two calls" is not a
 * pattern, it is two classifications that failed. Everything downstream would
 * inherit that as a confident claim about a buyer.
 *
 * TWO CALLS, NOT TWO INSTANCES. A buyer who circles the same worry three times
 * in one conversation has one objection, not three. The count is over DISTINCT
 * CALLS, which is also what makes the founder's phrasing — "on the last two
 * calls" — true when we say it.
 *
 * Deterministic and clock-free, for the same reason the dossier is: this ends
 * up inside a cached prompt prefix, and a tie broken by iteration order or a
 * date rendered relatively would silently cost the cache on every cue.
 */

export interface MinedObjection {
  id: string
  type?: string
  objectionQuote?: string
  responseQuote?: string
  recoveredWell?: boolean
  judgmentNote?: string
  callId?: string
  createdAt?: string
}

export interface PreloadCall {
  id: string
  contactId?: string
  createdAt?: string
  deleted?: boolean
}

export interface ObjectionPreload {
  /** 'price' | 'timing' | 'trust' | 'approval' | 'competitor' — never 'other'. */
  type: string
  /** Distinct CALLS on which this type came up. Always >= 2. */
  calls: number
  /** ISO day of the most recent call it came up on. */
  lastRaised: string
  /** Their own words, most recently. */
  theirWords: string
  /**
   * What happened on an occasion the model judged recovered. Absent when
   * nothing has worked yet — itself worth knowing, and why this is optional
   * rather than defaulted to the newest response.
   *
   * `kind` matters to the reader. MEASURED on the founder's 145 recovered
   * objections: 30 of them (21%) have a `responseQuote` under 25 characters —
   * "And yeah.", "Yes. Correct." — because the miner captured a fragment
   * rather than the substantive reply. Presenting one of those as "the thing
   * that worked" tells a rep to say "And yeah" to a trust objection, which is
   * worse than saying nothing. All 145 carry a `judgmentNote` describing what
   * actually happened, so a fragment falls back to that and is LABELLED as a
   * description rather than passed off as a quotable line.
   */
  whatWorked?: { words: string; on: string; kind: 'quote' | 'description' }
}

/** Below this, a `responseQuote` is a fragment rather than a reply. Set from
 *  the measured distribution above (min 6, p25 28, median 56), not by taste. */
const MIN_QUOTABLE = 25

/** The model's "I could not classify this", excluded by design — see above. */
const UNCLASSIFIED = new Set(['other', 'unknown', 'none', ''])

const clean = (s: unknown, max: number): string => {
  if (typeof s !== 'string') return ''
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

const isoDay = (iso: string | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/**
 * What this buyer has pushed back on more than once, and what worked.
 * Returns [] when there is no pattern — which is the answer for most contacts
 * and must stay that way.
 */
export function buildObjectionPreload(input: {
  contactId: string
  calls: PreloadCall[]
  objections: MinedObjection[]
  /** How many patterns to return, highest count first. */
  limit?: number
}): ObjectionPreload[] {
  const limit = input.limit ?? 2
  const mine = new Map<string, string>() // callId -> createdAt of the CALL
  for (const c of input.calls) {
    if (c.deleted || c.contactId !== input.contactId) continue
    mine.set(c.id, c.createdAt ?? '')
  }
  if (!mine.size) return []

  const byType = new Map<string, MinedObjection[]>()
  for (const o of input.objections) {
    const type = String(o.type ?? '').toLowerCase()
    if (UNCLASSIFIED.has(type)) continue
    if (!o.callId || !mine.has(o.callId)) continue
    const a = byType.get(type) ?? []
    a.push(o)
    byType.set(type, a)
  }

  const out: ObjectionPreload[] = []
  for (const [type, list] of byType) {
    const callIds = new Set(list.map((o) => o.callId as string))
    if (callIds.size < 2) continue // once is an event, twice is a pattern

    // Newest first, by the CALL's date and then the objection's own id — a
    // stable total order, so two runs can never disagree.
    const sorted = [...list].sort((a, b) => {
      const t = String(mine.get(b.callId as string) ?? '').localeCompare(
        String(mine.get(a.callId as string) ?? '')
      )
      return t !== 0 ? t : String(a.id).localeCompare(String(b.id))
    })
    const newest = sorted[0]
    // Prefer a recovery that carries a QUOTABLE reply; fall back to any
    // recovery at all, described rather than quoted. Two passes rather than
    // one, so a fragment on the newest call cannot hide a real reply on an
    // older one.
    const recovered = sorted.filter((o) => o.recoveredWell === true)
    const quotable = recovered.find((o) => clean(o.responseQuote, 200).length >= MIN_QUOTABLE)
    const described = recovered.find((o) => clean(o.judgmentNote, 200).length >= MIN_QUOTABLE)

    const entry: ObjectionPreload = {
      type,
      calls: callIds.size,
      lastRaised: isoDay(mine.get(newest.callId as string)),
      theirWords: clean(newest.objectionQuote, 160)
    }
    if (quotable) {
      entry.whatWorked = {
        words: clean(quotable.responseQuote, 160),
        on: isoDay(mine.get(quotable.callId as string)),
        kind: 'quote'
      }
    } else if (described) {
      entry.whatWorked = {
        words: clean(described.judgmentNote, 160),
        on: isoDay(mine.get(described.callId as string)),
        kind: 'description'
      }
    }
    out.push(entry)
  }

  // Most-repeated first; ties by most recent, then by type name so the order
  // is total rather than merely mostly-decided.
  out.sort(
    (a, b) => b.calls - a.calls || b.lastRaised.localeCompare(a.lastRaised) || a.type.localeCompare(b.type)
  )
  return out.slice(0, limit)
}

/** One dossier line per pattern. Empty array in, empty array out. */
export function formatObjectionPreload(preloads: ObjectionPreload[]): string[] {
  return preloads.map((p) => {
    const head = `${p.type} — raised on ${p.calls} calls, most recently ${p.lastRaised}${
      p.theirWords ? `: "${p.theirWords}"` : ''
    }`
    // "Nothing has landed yet" is said out loud rather than left as an absence.
    // A rep reading a pattern with no answer beside it would reasonably assume
    // we simply had not looked.
    if (!p.whatWorked) return `${head} — nothing has landed on this one yet.`
    // Quoted and described are said differently on purpose. A description
    // dressed as a quote would put words in the rep's mouth that nobody said.
    return p.whatWorked.kind === 'quote'
      ? `${head} — what landed (${p.whatWorked.on}): "${p.whatWorked.words}"`
      : `${head} — it was resolved once (${p.whatWorked.on}), but nothing quotable was captured: ${p.whatWorked.words}`
  })
}
