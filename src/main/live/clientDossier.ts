/**
 * M39 Stage 3 — the client dossier: what the model should already know about
 * this buyer before the call starts.
 *
 * THE POINT IS THE PREFIX, NOT THE PROSE. Anthropic's prompt caching cuts
 * latency substantially on long prompts, but only when the front of the prompt
 * is a STABLE PREFIX — byte-identical between calls, with the dynamic content
 * last. So this block is assembled once per call and must then be reproducible
 * to the byte: no relative dates ("3 days ago" changes under you mid-call), no
 * clock reads, no iteration over an unordered map, no locale formatting. Those
 * are not stylistic preferences here; each one silently costs the cache.
 * `buildClientDossier` takes no clock and calls no date formatter that varies
 * by machine, and a test asserts two builds over the same records are equal.
 *
 * THE BUDGET. BUG-225 measured a 2,290 ms live-cue baseline against a 6,000 ms
 * budget, and BUG-222 measured +166 ms for +143 tokens of client facts. This
 * block is capped in CHARACTERS rather than tokens because the app has no
 * tokenizer, and the cap is enforced by dropping whole items from the bottom of
 * the ranking rather than by cutting a string in half — a dossier that ends
 * mid-sentence teaches the model that its context is unreliable.
 *
 * WHAT IS IN IT, AND WHAT WAS CUT BEFORE A LINE WAS WRITTEN. The founder ranked
 * six sections. Measured against the only real corpus that exists (their own
 * profile: 197 live calls, 96 linked, 50 contacts, 13 deals, 28 tasks):
 *
 *   1. current valid facts (contact KYC)   — 0 to 4 of 50 contacts carry each
 *                                            field. THIN, kept, because what is
 *                                            there is high-value and hand-entered.
 *   2. open commitments                    — 4 open tasks (28 total, 24 already
 *                                            done), 55 calls with a nextAction,
 *                                            84 with action items. STRONG on the
 *                                            call-derived side, THIN on tasks —
 *                                            and this line first read "28 open
 *                                            tasks" because the filter and the
 *                                            script that counted for it made the
 *                                            same wrong assumption about how the
 *                                            app marks a task done.
 *   3. objection history                   — 55 calls with an objection read,
 *                                            15 with a verified verbatim quote. STRONG.
 *   4. what worked                         — 55 coached calls, 20 contacts with
 *                                            2+ calls to compare. STRONG.
 *   5. deal state                          — 13 of 13 deals have a stage;
 *                                            **0 of 13 have a risk assessment**.
 *                                            Kept for stage; risk omitted. The
 *                                            stage then failed to arrive for
 *                                            three commits: this builder takes a
 *                                            `stageLabel` and the store passed
 *                                            `null`, while the MEASURING script
 *                                            resolved it properly — so the
 *                                            measured dossier had a stage and the
 *                                            shipped one did not. Now 12 of 12
 *                                            contacts whose deal sits in a named
 *                                            stage carry it (dossier-store.ts's
 *                                            `readStageLabel`).
 *   6. stakeholder map                     — **0 contacts name another
 *                                            stakeholder and 0 share a company.**
 *                                            CUT. Building it would ship a
 *                                            section that renders nothing on the
 *                                            only data anyone can check it
 *                                            against, and an empty section in a
 *                                            cached prefix costs tokens forever.
 *
 * That last one is the "a zero means the mechanism is missing OR the population
 * is empty" rule applied before the code rather than after it. Section 6 is not
 * hard; it is unfeedable today. When the CRM note generator has filled
 * `otherStakeholders` on a few contacts, it becomes worth writing.
 *
 * NOT FROM THE SALES BRAIN. BUG-258: 0 of 73 memories are `active` and every
 * compiled profile is 0 chars, so a memory-sourced dossier would be an empty
 * string on this profile. Every fact below comes from a record the app wrote
 * itself and can show the user on the Contact page.
 *
 * KNOWN LIMIT — NOT BI-TEMPORAL, AND THE BRIEF ASKED FOR IT. "Current valid
 * facts, bi-temporally correct — what's true now, not what was." The
 * prior-call sections carry a date each, so a model can at least tell how old
 * they are. The KYC fields cannot: a contact record has no validity window, so
 * whatever is in `personalNotes` is presented as true forever. It is not
 * theoretical — on the founder's own profile one contact's dossier says
 * "unable to go to the bank today because the neighbour would not be back
 * until 6 PM", which will be BACKGROUND on every future call with her.
 * `memory.db` has the bi-temporal shape (valid-from / valid-to per fact) and
 * contacts do not, so closing this is a data-model change and reserved. Until
 * then the honest position is that section 1 is *known*, not *current*, and
 * the section's own heading says "Known facts" rather than "Current facts".
 *
 * EGRESS, named because a path that is not enumerated is the mistake this
 * milestone already made once. Everything this assembles is sent to the AI
 * provider on every live cue: hand-entered KYC fields, prior-call summaries,
 * and the buyer's verbatim quotes from EARLIER calls. `consentPermitsCapture`
 * runs before the dossier is built, so a consent-blocked cue carries none of
 * it — but a mono cue declaring `includesBuyerContent: false` still carries
 * quotes the buyer gave weeks ago, because they are stored facts rather than
 * this call's audio. Precedent: the prep brief already sends a `LAST CALL`
 * block to the same provider. Recorded on BUG-263's egress table.
 */

import {
  buildObjectionPreload,
  formatObjectionPreload,
  type MinedObjection
} from './objectionPreload'

/** Only the fields this module reads, so a caller can pass its own shapes. */
export interface DossierContact {
  id: string
  name: string
  company?: string
  title?: string
  decisionAuthority?: string
  otherStakeholders?: string
  dealValue?: number
  budgetIndication?: string
  timeline?: string
  competitors?: string
  knownObjections?: string
  currentTooling?: string
  personalNotes?: string
}

export interface DossierCall {
  id: string
  title?: string
  createdAt?: string
  contactId?: string
  deleted?: boolean
  summary?: { executive?: string; actionItems?: unknown }
  coaching?: {
    overallScore?: number
    nextAction?: string
    dimensions?: {
      key?: string
      comment?: string
      evidence?: { verified?: boolean; quote?: string }
    }[]
  }
}

export interface DossierTask {
  id: string
  title?: string
  done?: boolean
  /** The app writes `status` and `completedAt`; `done` is accepted too so a
   *  caller with either shape works — and `done` alone is what the FIRST cut of
   *  this filter read, on a store that has never written it. Measured on the
   *  founder's profile: 28 tasks, 24 complete, 4 genuinely open, 3 of those
   *  carrying a dueAt (25 across all 28). */
  status?: string
  completedAt?: string
  dueAt?: string
  callId?: string
  contactId?: string
}

export interface DossierDeal {
  id: string
  title?: string
  contactId?: string
  stageId?: string
  value?: number
  /** Stage transitions, newest last, as `deals-fs.ts` writes them. Present on
   *  4 of the founder's 13 deals — measured, so the "since your last call"
   *  line's thinness is a known property rather than a surprise. */
  stageHistory?: { stageId?: string; changedAt?: string }[]
}

export interface DossierInput {
  contact: DossierContact
  deal?: DossierDeal | null
  stageLabel?: string | null
  /** Every call; this filters to the contact's own and sorts them itself. */
  calls: DossierCall[]
  tasks: DossierTask[]
  /** Every mined objection; filtered to this contact's calls here. Optional,
   *  so a caller that has none simply gets a dossier without that section. */
  objections?: MinedObjection[]
  /**
   * The moment this call started, as an ISO string. The ONLY time input this
   * builder takes, and it is a parameter rather than a clock read on purpose:
   * "overdue" is genuinely time-dependent, and a `Date.now()` inside would
   * make the output differ between two cues on the same call, which is exactly
   * what the cached prefix cannot survive. Passed once per call, frozen.
   */
  asOf?: string
  /** Hard character cap on the whole block. */
  maxChars?: number
}

export interface Dossier {
  /** The block to put at the front of the prompt. '' when there is nothing. */
  text: string
  chars: number
  /** Section labels actually present, in order. */
  sections: string[]
  /** Items the cap dropped. Reported rather than hidden — a silently truncated
   *  dossier and a thin one look identical from the outside. */
  dropped: number
}

/** 1,200 characters ≈ 300 tokens at the usual 4-chars-per-token rule of thumb.
 *  Chosen against BUG-222's measured +166 ms for +143 tokens: roughly double
 *  that content, so on the order of +350 ms on a 2,290 ms baseline against a
 *  6,000 ms budget — and that is BEFORE prompt caching, which this block's
 *  stability is what makes possible. The number is a starting point to be
 *  measured against a real round trip, not a finding. */
export const DEFAULT_DOSSIER_CHARS = 1200

/** Deliberately not `toLocaleDateString`: the output must be identical on every
 *  machine and at every hour, or the cached prefix is not a prefix. */
function isoDay(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

function clean(s: unknown, max = 220): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/**
 * What moved between this contact's LAST call and the one before it.
 *
 * The window is (previous call, now]. Not (previous, last]: a task closed the
 * morning after the last call is still news to a rep starting the next one,
 * and the alternative — silently ignoring everything since — would make the
 * line quietly wrong rather than merely absent.
 *
 * `asOf` is not consulted. Nothing here is relative to the present moment, so
 * there is no clock read to make the cached prefix drift mid-call.
 *
 * Returns at most three lines, one per signal, in a fixed order — never sorted
 * by a timestamp, which would reorder the prefix between two assemblies of the
 * same call if a record were rewritten underneath it (BUG-185 does exactly
 * that on every sync).
 */
function sinceLastCall(
  contactId: string,
  callsNewestFirst: DossierCall[],
  input: DossierInput
): string[] {
  if (callsNewestFirst.length < 2) return []
  const prevAt = Date.parse(callsNewestFirst[1]?.createdAt ?? '')
  if (!Number.isFinite(prevAt)) return []
  const out: string[] = []

  // 1. The deal moved. 4 of 13 of the founder's deals carry a stageHistory at
  //    all, so this is thin by construction — stated, not discovered later.
  const deal = input.deal
  const moves = (deal?.stageHistory ?? [])
    .filter((h) => {
      const t = Date.parse(h?.changedAt ?? '')
      return Number.isFinite(t) && t > prevAt
    })
    .map((h) => h.stageId)
  const landedOn = moves.length ? moves[moves.length - 1] : null
  if (landedOn) {
    // TWO FACTS, and the line must not blur them: something moved inside the
    // window (the history says so), and the deal is at THIS stage now (the
    // record says so). They are not the same claim — 2 of the founder's deals
    // have a history that stops short of their current stage, so the last
    // recorded transition is not where the deal ended up.
    //
    // Only the CURRENT stage has a resolved label; a historical stageId would
    // have to be rendered as a raw id ("404325fd-6b90-…"), which is worse in a
    // prompt than not naming it. So: say it moved, and say where it stands —
    // never "moved to X" unless X is both.
    const now = clean(input.stageLabel, 40)
    out.push(
      landedOn === deal?.stageId && now
        ? `The deal moved to ${now}.`
        : now
          ? `The deal has moved since — it is at ${now} now.`
          : 'The deal moved to a new stage.'
    )
  }

  // 2. A promise to THIS contact was kept. Only 11 of 28 tasks carry a
  //    contactId, so the call-linked fallback matters as much as the direct one.
  const callIds = new Set(callsNewestFirst.map((c) => c.id))
  const closed = input.tasks
    .filter((t) => {
      if (t.contactId !== contactId && !(t.callId && callIds.has(t.callId))) return false
      const at = Date.parse(t.completedAt ?? '')
      return Number.isFinite(at) && at > prevAt
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const firstClosed = clean(closed[0]?.title, 100)
  if (firstClosed) {
    out.push(
      closed.length > 1
        ? `You have since done: ${firstClosed} (and ${closed.length - 1} more).`
        : `You have since done: ${firstClosed}.`
    )
  }

  // 3. What they push back on shifted. The only signal here that is about the
  //    BUYER rather than about the rep, which is why it is kept despite firing
  //    for one contact on today's corpus.
  const typeOn = (callId: string): string | null => {
    const mine = (input.objections ?? []).filter((o) => o.callId === callId)
    const named = mine.find((o) => o.type && !UNCLASSIFIED_TYPES.has(String(o.type).toLowerCase()))
    return named ? String(named.type) : null
  }
  const before = typeOn(callsNewestFirst[1]!.id)
  const after = typeOn(callsNewestFirst[0]!.id)
  if (before && after && before !== after) {
    out.push(`Their pushback shifted from ${clean(before, 30)} to ${clean(after, 30)}.`)
  }

  return out
}

const UNCLASSIFIED_TYPES = new Set(['other', 'unknown', 'none', ''])

/** One line of the dossier, with the rank that decides what survives the cap. */
/**
 * Every heading the dossier can emit.
 *
 * A UNION RATHER THAN A STRING, and the reason is a bug this file shipped.
 * `render` iterates ORDER, not the items, so a section missing from ORDER is
 * dropped in silence: "Since your last call with them" produced lines, ranked
 * above most of the dossier, survived the cap, and rendered to nothing — 0 of
 * 50 contacts against a measured population of 6.
 *
 * The first attempt to guard that was a test looping over the dossier's
 * reported `sections`, which is populated BY ORDER — so an unlisted section
 * never enters it and the loop was vacuous. It passed with the bug present.
 * A test cannot check this; the type can. `ORDER` below is declared
 * `readonly Section[]` and checked for completeness at compile time, so
 * omitting a section is a build error rather than a blank space in a prompt.
 */
export type DossierSection =
  | 'Known facts'
  | 'Deal'
  | 'Since your last call with them'
  | 'Open commitments'
  | 'They have pushed back on this before'
  | 'Last call'
  | 'What they pushed back on'
  | 'How these calls have gone'

interface Item {
  section: DossierSection
  line: string
  /** Higher survives. relevance × confidence × recency, all in this number. */
  rank: number
}

/** Recency as a 0-1 multiplier, from ORDER not from the clock: the newest call
 *  for this contact scores 1, the oldest ~0.4. Using a clock here would make
 *  the same records produce a different dossier tomorrow, which is exactly
 *  what a stable prefix cannot do. */
function recencyWeight(index: number, total: number): number {
  if (total <= 1) return 1
  return 1 - (0.6 * index) / (total - 1)
}

export function buildClientDossier(input: DossierInput): Dossier {
  const maxChars = input.maxChars ?? DEFAULT_DOSSIER_CHARS
  const contact = input.contact
  const items: Item[] = []

  // Newest first. A stable sort on a stable key — createdAt then id, so two
  // calls stamped the same second cannot swap places between builds.
  const calls = input.calls
    .filter((c) => !c.deleted && c.contactId === contact.id)
    .sort((a, b) => {
      const t = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
      return t !== 0 ? t : String(a.id).localeCompare(String(b.id))
    })

  // --- 1. Current valid facts ------------------------------------------------
  // Hand-entered or rep-accepted, so confidence is high; thin on this corpus
  // (0-4 of 50 contacts per field) but worth the most per character when present.
  const FACTS: [keyof DossierContact, string][] = [
    ['title', 'Role'],
    ['decisionAuthority', 'Decision authority'],
    ['budgetIndication', 'Budget'],
    ['timeline', 'Timeline'],
    ['competitors', 'Competing with'],
    ['currentTooling', 'Uses today'],
    ['knownObjections', 'Known objections'],
    ['personalNotes', 'Personal']
  ]
  for (const [key, label] of FACTS) {
    const v = clean(contact[key], 140)
    if (v) items.push({ section: 'Known facts', line: `${label}: ${v}`, rank: 90 })
  }
  if (contact.company) {
    items.push({ section: 'Known facts', line: `Company: ${clean(contact.company, 60)}`, rank: 88 })
  }

  // --- 5. Deal state ---------------------------------------------------------
  // Stage only. 0 of 13 deals on the real profile carry a risk assessment, so a
  // risk line would be a line that never appears.
  if (input.deal) {
    const bits = [
      clean(input.deal.title, 60),
      input.stageLabel ? `stage: ${clean(input.stageLabel, 40)}` : ''
    ]
      .filter(Boolean)
      .join(' — ')
    if (bits) items.push({ section: 'Deal', line: bits, rank: 85 })
  }

  // --- 2. Open commitments ---------------------------------------------------
  // The strongest section by population and the most actionable mid-call: a
  // promise nobody kept is the thing a rep most wants named while they can
  // still act on it. Open tasks first, then the last call's stated next action.
  //
  // STAGE 4 FEATURE #4, the half of it the records can carry. "You said you'd
  // send the security doc on the 3rd. You haven't." — the "you haven't" needs
  // a due date and a check, and tasks have `dueAt` on 25 of the founder's 28.
  // Measured there: 25 open AND past due. The REVERSE half — what the BUYER
  // promised and has not delivered — has no extractor and is cut; see the
  // milestone note for the corpus it would need.
  //
  // `asOf` and not a clock read. Overdue is the one thing in this file that
  // genuinely depends on when it is asked, and a `Date.now()` here would break
  // the byte-identical prefix the whole dossier exists to preserve. So the
  // caller passes the moment the CALL started, once, and every cue in that
  // call re-derives the same answer.
  const done = (t: DossierTask): boolean =>
    t.done === true || t.status === 'done' || t.status === 'completed' || !!t.completedAt
  const openTasks = input.tasks
    .filter((t) => !done(t) && (t.contactId === contact.id || calls.some((c) => c.id === t.callId)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  for (const t of openTasks.slice(0, 4)) {
    const v = clean(t.title, 120)
    if (!v) continue
    const due = t.dueAt && isoDay(t.dueAt)
    const overdue = !!(due && input.asOf && due < isoDay(input.asOf))
    items.push({
      section: 'Open commitments',
      line: overdue ? `${v} — was due ${due}, still open` : due ? `${v} (due ${due})` : v,
      // An overdue promise outranks an open one. It is the single most
      // actionable thing a rep can be handed mid-call, and the only line in
      // the dossier that is about something going wrong.
      rank: overdue ? 84 : 80
    })
  }
  const lastAction = clean(calls[0]?.coaching?.nextAction, 140)
  if (lastAction) {
    items.push({
      section: 'Open commitments',
      line: `Agreed last call (${isoDay(calls[0]?.createdAt)}): ${lastAction}`,
      rank: 79
    })
  }

  // --- 2b. Since the last call (Stage 4 #5) -----------------------------------
  //
  // MEASURED BEFORE IT WAS WRITTEN, and the number the founder had was wrong.
  // It was sized to them as "14 of 20 multi-call contacts have something that
  // moved". Counted properly — with the time window the feature actually uses,
  // and after the `status: 'done'` task fix — it is **6 of 20**, i.e. 6 of 50
  // contacts would ever see this line: 2 a deal stage, 3 a completed task, 1 a
  // changed objection read. Comparable to objection pre-loading (7 of 50),
  // which shipped.
  //
  // THE FOURTH SIGNAL WAS CUT, not because it was empty but because it was not
  // a change: "the last call produced a summary and the one before it did not"
  // fires for 1 contact and says nothing a rep can use. If the data cannot
  // support a claim, say nothing rather than something vague.
  //
  // WHY IT IS WORTH A LINE AT ALL, given a rep did most of this themselves:
  // the value is not news, it is not re-promising. A rep who already sent the
  // proposal should not offer to send it again, and the objection shift — what
  // they pushed back on LAST time versus the time before — is the one signal
  // here that is genuinely about the buyer rather than about the rep.
  const changes = sinceLastCall(contact.id, calls, input)
  for (const line of changes) {
    items.push({
      section: 'Since your last call with them',
      line,
      // Above objection history (82), below an overdue promise (84): recent
      // movement is the most actionable thing after something going wrong.
      rank: 83
    })
  }

  // --- 3. Objection history --------------------------------------------------
  // A verified verbatim quote outranks a coaching paraphrase: it is the buyer's
  // own words, and 15 of the founder's calls carry one.
  //
  // BOTH the quote and the coaching read are emitted, and the cap decides.
  // The first version returned after the quote — measured on the real profile,
  // that was wrong in both directions: Brett's quote is the buyer flatly
  // refusing ("Okay. So what? You don't have even, like, $23 to put into the
  // account?") and carries the whole objection, while Belinda's verified quote
  // is "We can talk in half an hour. Sure." — evidence of nothing, whose
  // coaching read was the useful half and was being thrown away. Neither is
  // reliably the better line, so both go in ranked and the budget arbitrates.
  calls.forEach((call, i) => {
    const dim = call.coaching?.dimensions?.find((d) => d.key === 'objection')
    if (!dim) return
    const w = recencyWeight(i, calls.length)
    const quote = clean(dim.evidence?.verified ? dim.evidence.quote : '', 140)
    if (quote) {
      items.push({
        section: 'What they pushed back on',
        line: `${isoDay(call.createdAt)} — they said: "${quote}"`,
        rank: 70 * w + 6
      })
    }
    const comment = clean(dim.comment, 160)
    if (comment) {
      items.push({
        section: 'What they pushed back on',
        line: `${isoDay(call.createdAt)} — how it went: ${comment}`,
        rank: 70 * w
      })
    }
  })

  // --- 2b. What the last call was actually about -----------------------------
  //
  // ADDED AFTER MEASURING, not designed in. The first version gave a dossier to
  // 23 of 50 contacts and NOTHING to 27, because every section needed coaching,
  // a deal, an open task or a hand-entered field. Meanwhile 95 of the founder's
  // calls carry a stored `summary.executive` that nothing here was reading —
  // the same text the Contact page already shows under "Call history", and the
  // richest sentence about a buyer the app owns. Ranked below the commitments
  // (a broken promise beats background) and truncated hard, because one of
  // these is 400 characters and the whole budget is 1200.
  const lastSummary = clean(calls[0]?.summary?.executive, 260)
  if (lastSummary) {
    items.push({
      section: 'Last call',
      line: `${isoDay(calls[0]?.createdAt)} — ${lastSummary}`,
      rank: 76
    })
  }

  // --- STAGE 4 #1. Objection pre-loading -------------------------------------
  // What this buyer has pushed back on MORE THAN ONCE, and what landed. Ranked
  // just under an overdue commitment and above everything merely historical,
  // because it is the only section that says what is about to happen rather
  // than what already did. 8 of the founder's 50 contacts have a repeated
  // objection type; see objectionPreload.ts for why `other` — 108 of the 287
  // mined records — is excluded rather than counted.
  if (input.objections?.length) {
    const preloads = buildObjectionPreload({
      contactId: contact.id,
      calls,
      objections: input.objections
    })
    for (const line of formatObjectionPreload(preloads)) {
      items.push({ section: 'They have pushed back on this before', line, rank: 82 })
    }
  }

  // --- 4. What worked --------------------------------------------------------
  // Only stated when there is a comparison to make: one score is a number, two
  // are a direction. Absolute scores, never "improving" — the model can read a
  // direction out of two numbers, and a label would be us guessing for it.
  const scored = calls.filter((c) => typeof c.coaching?.overallScore === 'number')
  if (scored.length >= 2) {
    const newest = scored[0]
    const previous = scored[1]
    items.push({
      section: 'How these calls have gone',
      line: `Coaching score ${newest.coaching?.overallScore} on ${isoDay(newest.createdAt)}, ${previous.coaching?.overallScore} on ${isoDay(previous.createdAt)} (${scored.length} coached calls).`,
      rank: 60
    })
  }

  // --- assemble --------------------------------------------------------------
  // Ranked globally, so the cap drops the least valuable line in the whole
  // dossier rather than truncating whichever section happens to come last.
  // A SECTION MISSING FROM THIS LIST IS SILENTLY DROPPED. `render` iterates
  // ORDER, not `items`, so a new section can produce lines, rank above most of
  // the dossier, survive the cap, and render to nothing at all — which is
  // exactly what "Since your last call with them" did on its first run: 0 of
  // 50 contacts, from a population measured at 6. Nothing threw, nothing was
  // red, and the only reason it was caught is that the zero was CHECKED
  // against the population rather than read as "there was nothing to say".
  // `clientDossier.sectionOrder.test.ts` now fails if any emitted section is
  // not listed here.
  const ORDER = [
    'Known facts',
    'Deal',
    'Since your last call with them',
    'Open commitments',
    'They have pushed back on this before',
    'Last call',
    'What they pushed back on',
    'How these calls have gone'
  ] as const satisfies readonly DossierSection[]
  // COMPLETENESS, checked by the compiler rather than by a test that could not
  // see the omission. Adding a member to `DossierSection` without adding it to
  // ORDER makes this line fail to compile: the object's keys are exactly
  // ORDER's members, and it must satisfy a record over the whole union.
  const _orderIsComplete: Record<DossierSection, true> = Object.fromEntries(
    ORDER.map((s) => [s, true])
  ) as Record<(typeof ORDER)[number], true>
  void _orderIsComplete
  const byRank = [...items].sort((a, b) => b.rank - a.rank || a.line.localeCompare(b.line))

  /** Render a candidate set. Separated from the budgeting so the cap can be
   *  enforced against the STRING, not against an estimate of it. */
  const render = (set: Item[]): { text: string; sections: string[] } => {
    const sections: string[] = []
    const lines: string[] = [`CLIENT: ${clean(contact.name, 60)}`]
    for (const section of ORDER) {
      const mine = set.filter((k) => k.section === section)
      if (!mine.length) continue
      sections.push(section)
      lines.push(`${section}:`)
      // Within a section, the global rank still decides order.
      for (const m of [...mine].sort((a, b) => b.rank - a.rank || a.line.localeCompare(b.line))) {
        lines.push(`- ${m.line}`)
      }
    }
    return { text: lines.join('\n'), sections }
  }

  // MEASURED AGAINST THE OUTPUT, not against a per-line estimate. The first
  // version budgeted `line.length + 3` and never counted the `CLIENT:` header
  // or the section headings, so it produced 1,255 characters against a 1,200
  // cap on the founder's own records — a cap that did not cap. Dropping the
  // lowest-ranked line and re-rendering is exact, and the loop is bounded by
  // the item count, which is under thirty.
  let kept = byRank
  let out = render(kept)
  while (out.text.length > maxChars && kept.length > 0) {
    kept = kept.slice(0, -1)
    out = render(kept)
  }
  const dropped = items.length - kept.length
  // EMPTY IS DECIDED BY WHAT RENDERED, not by what was collected. `kept.length`
  // counts items; an item whose section is missing from ORDER contributes
  // none of them, so a dossier could come back as the bare line "CLIENT: Foo"
  // — a heading, a name, and nothing to know. Measured when the new section
  // was unlisted: coverage read 30 of 50 instead of 29, and the extra one was
  // precisely that empty shell being handed to the model as context.
  if (!out.sections.length) return { text: '', chars: 0, sections: [], dropped }
  return { text: out.text, chars: out.text.length, sections: out.sections, dropped }
}
