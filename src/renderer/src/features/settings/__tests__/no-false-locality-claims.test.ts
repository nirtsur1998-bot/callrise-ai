// BUG-200 — the app must not tell a user their data stays on their device
// when it does not.
//
// WHY THIS IS A TEST AND NOT A REVIEW. Three strings were found by reading
// the Sales Brain card. Two MORE were found only by sweeping the whole
// renderer for the VOCABULARY of the claim rather than for the sentence
// already known — activationSteps.ts and MemoryCenterSection.tsx, neither of
// which anyone had thought to look at. That is memory
// `absence-tests-enumerate-the-container`: "nothing says X" cannot be checked
// by grepping the strings you happen to know. It has to enumerate.
//
// WHAT IS ACTUALLY FALSE, so this is not cargo-culted. Seven categories of
// user data can be uploaded to Supabase (BackupSyncScope).
//
// BUG-211, a correction to what this header said for most of a day: two of
// them are ON in EMPTY_SYNC_SCOPE, but that object is reached ONLY when there
// is no settings file at all. sanitizeSyncScope resolves an ABSENT key to
// false, so an install that predates those keys has both OFF. "Defaults ON"
// means a genuinely fresh profile, not everybody.
//
// So the claim is false for a fresh profile, and false for any user whose
// toggles are on — which includes the founder's own. It is not false for an
// upgraded install that never touched Backup settings. The copy was wrong for
// all of them; the UPLOAD only happened for some, and conflating those two is
// the mistake this note exists to stop repeating.
//
// Every hit is accounted for by a written reason, so allowlisting is an
// argument someone has to make rather than a line someone can add. A bare
// "known-good" list is how the two extra sites would have been hidden
// instead of found.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER = join(__dirname, '..', '..', '..')

/** The vocabulary of "your data stays here". Deliberately broad: a false
 *  positive costs one entry with a reason, a false negative ships a lie
 *  about where someone's calls live. */
const LOCALITY_CLAIMS: RegExp[] = [
  /entirely on your (own )?device/i,
  /only on (this|your) (own )?(device|computer|machine)/i,
  /live only on/i,
  /stays? on your (own )?device/i,
  /on-?device only/i,
  /never (leaves|leave|uploaded|sent|transmitted|shared)/i,
  /nothing is (sent|uploaded|shared|stored)/i,
  /not (sent|uploaded|shared) anywhere/i,
  /(100%|fully|purely|entirely) local/i,
  /locally only/i,
  /no cloud/i,
  /never (goes|go) to the cloud/i,
  /we (never|do not|don'?t) (see|store|upload|collect|keep a copy|have a copy)/i,
  /stored (and searched )?locally/i,
  // ── Added after the adversarial red check documented below. Each of these
  //    defeated the list above on the first attempt.
  /on (this|your) (computer|machine|laptop|pc|mac)( and nowhere else)?/i,
  /nowhere else/i,
  /stays? (right )?(here|put)/i,
  /no servers?/i,
  /yours alone/i,
  // ── Added 2026-09-07 after an independent sweep found SIX sites this list
  //    did not catch. Round 3 of the measurement, and this one was not a
  //    fixture: every sentence below is real shipped copy.
  /nothing new leaves your (device|computer)/i,
  /completely unaffected/i,
  /nothing has been sent/i,
  /no extra AI calls/i
]

/* ── WHAT THIS GUARD IS, MEASURED ─────────────────────────────────────────
 *
 * It is a NET, not a proof, and its escape rate was measured rather than
 * assumed. Five false sentences were written in wording the list had not
 * been built against:
 *
 *   "Everything is kept on this computer and nowhere else."
 *   "Your memories stay put. We do not keep a copy."
 *   "Processed on your machine, full stop."
 *   "Your data is yours alone and stays right here."
 *   "No servers involved."
 *
 * The guard caught ZERO of the five. All five now have a pattern above.
 *
 * Then a SECOND round was written against the EXTENDED list, to measure
 * whether extending helps or merely chases:
 *
 *   "What you say here goes no further than the app itself."
 *   "The only copy of this lives where you are sitting."
 *   "Held close: your notes are for your eyes."
 *   "This information is confined to the installation you are using."
 *   "Offline by design, and it stays that way."
 *
 * Round 1 after extension: 5 caught of 5.   Round 2: 0 caught of 5.
 *
 * That is the number to keep. Extending closes exactly the holes already
 * found and does nothing for the next one. Round 2 is deliberately NOT added
 * to the patterns — a list tuned until its own examples pass would report a
 * coverage it does not have, which is the failure this milestone is about.
 *
 * The honest statement of what it does: it catches a REPHRASING of a known
 * claim (it found BackupCard.tsx on its first run, which a hand sweep for
 * "never leaves" had missed because that sentence says "never leave"), and
 * it does not catch a genuinely novel way of saying the same thing. The rest
 * of the coverage is a human reading privacy copy, which is the founder's
 * standing rule and the reason it is a rule.
 * ────────────────────────────────────────────────────────────────────── */

/** Hits that are NOT a false statement about where user data lives, each
 *  with the reason. The key is a `file` + `contains` pair, specific enough
 *  that rewriting the sentence invalidates the entry and brings the guard
 *  back rather than blessing the new wording. */
const ACCOUNTED_FOR: { file: string; contains: string; because: string }[] = [
  {
    file: 'features/assistant/AssistantView.tsx',
    contains: 'Nothing is sent until you press',
    because:
      'True, and about the Deepgram live stream: the websocket in src/main/transcription.ts is ' +
      'not opened until the user starts a session.'
  },
  {
    file: 'features/backup/BackupCard.tsx',
    contains: 'Your Google Calendar connection — stays only on this device',
    because:
      'True in the sense a user reads it: the OAuth refresh token is stored separately by ' +
      'google.ts (saveRefreshToken) and is never part of any backup payload, so a new device ' +
      'genuinely must reconnect — which is what the next clause of the same sentence says. ' +
      'The NUANCE, checked rather than assumed: the settings push uploads `payload: settings`, ' +
      'the whole AppSettings object, which includes the boolean `googleCalendarConnected`. That ' +
      'field is a non-secret marker and its own comment says so; the credential does not travel.'
  },
  {
    file: 'features/settings/TelemetrySection.tsx',
    contains: 'nothing is sent',
    because:
      'True: the telemetry-off branch of the same function. Telemetry defaults off and has no ' +
      'remote toggle (see memory structurally-unflaggable-switches).'
  },
  {
    file: 'features/settings/TelemetrySection.tsx',
    contains: 'A random number made on this computer',
    because:
      'Describes where the anonymous diagnostics id is GENERATED, not where user data is kept. ' +
      'True as written, and the id is deleted when diagnostics go off.'
  },
  {
    file: 'features/settings/telemetry-copy.ts',
    contains: 'or files on your computer',
    because: 'An enumeration of what is NOT sent. True, and the opposite of a false locality claim.'
  },
  {
    file: 'features/settings/SalesBrainSection.tsx',
    contains: 'has no memories on this machine',
    because:
      'An empty state about the LOCAL store having nothing to export. Says nothing about whether ' +
      'a copy exists elsewhere.'
  },
  {
    file: 'features/audio/useMicTest.ts',
    contains: 'could not be played back on this computer',
    because:
      'Not a data-location claim — an audio OUTPUT device error. Caught by the broadened ' +
      '"on this computer" pattern, which is the price of a net wide enough to catch a rephrasing.'
  },
  {
    file: 'features/calendar/EventDialog.tsx',
    contains: 'Notifies you on this computer, only while CallRise AI is open',
    because:
      'Describes where a NOTIFICATION appears, not where data is kept. True: local notifications ' +
      'need the app running.'
  }
]

/** Sites that ARE false and are NOT YET FIXED, because privacy copy is
 *  approved word by word by the founder and these two have not been.
 *
 *  Pinned to their exact contents on purpose. The guard goes red when a
 *  THIRD false site appears, and ALSO when either of these is finally fixed
 *  — which forces the list to shrink rather than rot. Debt visible in the
 *  gate, not debt hidden by an allowlist. */
const PENDING_FOUNDER_APPROVAL: { file: string; contains: string }[] = [
  { file: 'features/home/activationSteps.ts', contains: 'Runs entirely on your own device' },
  { file: 'features/settings/MemoryCenterSection.tsx', contains: 'Nothing is sent anywhere' },
  // Found by DRIVING the app, not by reading source: it is the first thing on
  // the Privacy & data page, two paragraphs above that same page's own line
  // reading "Call recordings & transcripts sync is ON — your buyer
  // conversations are stored in your cloud account, not just this device."
  // Unconditional, and its doc comment calls it "a short, honest recap".
  // Three of the four categories it names were syncing when it was read.
  { file: 'features/settings/PrivacyNoticeCard.tsx', contains: 'live only on this' },
  // ── Added 2026-09-07. Four more, all found by an independent adversarial
  //    sweep rather than by this guard, and one of them had been recorded HERE
  //    as true.
  //
  // BackupCard: "never leave this computer unless you turn that on above" was
  // in ACCOUNTED_FOR with a written argument for why it was true. The argument
  // checked the transcripts toggle and the absence of an audio upload path and
  // stopped there. It missed that a Sales Brain memory's evidence is a
  // VERBATIM 400-character span of the transcript (extraction.ts:269), that
  // memory.db uploads to the sales-brain bucket, and the salesBrain sync key
  // is on for a fresh profile (BUG-211: an upgraded install has it off) and on
  // for anyone who set it. So with Sales Brain switched on and that key set,
  // word-for-word transcript text leaves the computer while this sentence says
  // it does not. An allowlist entry with a reason is still only as good as the
  // reason.
  { file: 'features/backup/BackupCard.tsx', contains: 'never leave this computer' },
  { file: 'features/coaching/CoachingView.tsx', contains: 'nothing new leaves your device' },
  { file: 'features/home/AccountMigrationNoticeCard.tsx', contains: 'completely unaffected' },
  { file: 'features/settings/TelemetrySection.tsx', contains: 'Nothing has been sent from this computer' }
]

/** Directories holding SIMULATED sales dialogue rather than UI copy. A
 *  fixture buyer saying "we don't have a ton of time" is not the app making
 *  a claim, and allowlisting each line of invented speech would bury the
 *  real hits under noise. */
const NOT_UI_COPY = ['simulator', 'fixtures', '__fixtures__', 'transcripts']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    if (NOT_UI_COPY.includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Blank out every character of a matched comment except its newlines, so
 *  line numbers in the report stay exact. */
function blankKeepingLines(text: string): string {
  return text.replace(/[^\r\n]/g, ' ')
}

/** Every line making a locality claim, comments removed — a comment is not
 *  something a user reads. (Comments that lie are species 84 and have their
 *  own guards; this one is about the screen.)
 *
 *  Comments are stripped PROPERLY rather than by skipping lines that start
 *  with a marker: a wrapped block comment whose continuation line has no
 *  leading `*` walked straight through the line test and was reported as UI
 *  copy. That was this guard's own first false positive. */
function findClaims(): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = []
  for (const file of walk(RENDERER)) {
    const rel = file.slice(RENDERER.length + 1).split('\\').join('/')
    const stripped = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, blankKeepingLines)
      .replace(/^([^\r\n]*?)\/\/[^\r\n]*$/gm, (_m, before: string) =>
        // Only treat `//` as a comment when it is not inside a string or a
        // URL. Crude, and deliberately biased toward KEEPING the line: a
        // kept comment costs an allowlist entry, a dropped string is a miss.
        /['"`]/.test(before) ? _m : before
      )
    // Each line is tested ON ITS OWN and JOINED TO THE NEXT, because a JSX
    // sentence that wraps was invisible to a line-at-a-time test: in
    // AccountMigrationNoticeCard.tsx "live on" ended one line and "this
    // computer" began the next, so no single line held both halves of a
    // pattern that needs both. An independent sweep found that site; this
    // guard walked straight past it. Two lines is not "enough" - a sentence
    // wrapped over three would still escape - but it is the width that
    // actually occurs in this codebase's JSX, and saying so is better than
    // implying the hole is closed.
    const lines = stripped.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!line.trim()) return
      const joined = (line + ' ' + (lines[i + 1] ?? '')).replace(/\s+/g, ' ')
      if (LOCALITY_CLAIMS.some((re) => re.test(line) || re.test(joined))) {
        found.push({ file: rel, line: i + 1, text: joined.trim() })
      }
    })
  }
  return found
}

describe('the app makes no false claim about where the user data lives', () => {
  const claims = findClaims()

  it('the sweep finds claims at all — otherwise this guard is vacuous', () => {
    // Without this, a pattern list that stops matching (a rename, a rewrite,
    // a directory move) turns the whole file green while checking nothing.
    expect(claims.length, 'the locality sweep matched nothing at all').toBeGreaterThan(4)
  })

  it('every locality claim is accounted for, or is a pinned known-false site', () => {
    const unaccounted = claims.filter((c) => {
      if (ACCOUNTED_FOR.some((t) => c.file === t.file && c.text.includes(t.contains))) return false
      if (PENDING_FOUNDER_APPROVAL.some((p) => c.file === p.file && c.text.includes(p.contains)))
        return false
      return true
    })

    expect(
      unaccounted.map((c) => `${c.file}:${c.line}`),
      'NEW copy claims the user data stays on their device. Seven categories are uploadable; two ' +
        'are on for a FRESH profile (an upgraded install has them off — BUG-211), and any of the ' +
        'seven is on once its toggle is. Either fix the sentence, ' +
        'or add an ACCOUNTED_FOR entry stating why it is not a false claim:\n  ' +
        unaccounted.map((c) => `${c.file}:${c.line}\n    ${c.text.slice(0, 160)}`).join('\n  ')
    ).toEqual([])
  })

  it('the seven sites awaiting founder approval are still exactly seven, and still there', () => {
    // Red in BOTH directions, so listed debt cannot quietly become permanent.
    for (const p of PENDING_FOUNDER_APPROVAL) {
      const hit = claims.find((c) => c.file === p.file && c.text.includes(p.contains))
      expect(
        hit,
        `"${p.contains}" is no longer in ${p.file}. If it was FIXED, delete its entry from ` +
          'PENDING_FOUNDER_APPROVAL — the pin exists to keep the debt visible, not to outlive it.'
      ).toBeDefined()
    }
    expect(
      PENDING_FOUNDER_APPROVAL.length,
      'the count of known-false, unapproved copy sites changed'
    ).toBe(7)
  })

  it('the three approved strings say where the data actually goes', () => {
    // The positive half. Removing a lie is not the same as telling the truth,
    // and a later edit could drop the honest clause while leaving the
    // negative check above perfectly green.
    const nav = readFileSync(join(RENDERER, 'features/settings/settings-nav.ts'), 'utf8')
    const card = readFileSync(join(RENDERER, 'features/settings/SalesBrainSection.tsx'), 'utf8')
    const clause = /included in your CallRise backup unless you turn that off/g
    expect(
      [...nav.matchAll(clause)].length,
      'settings-nav.ts lost a sentence saying the backup includes the Sales Brain'
    ).toBe(2)
    expect(
      [...card.matchAll(clause)].length,
      'SalesBrainSection.tsx lost the sentence saying the backup includes the Sales Brain'
    ).toBe(1)
    // And it must point at a page that EXISTS. "Settings → Backup" was the
    // approved wording and there is no such page — the settings-paths-in-copy
    // guard caught it on all three strings. Pinned here beside the sentence.
    expect(nav + card).not.toMatch(/Settings → Backup/)
    expect([...(nav + card).matchAll(/Settings → Privacy & data/g)].length).toBe(3)
  })

  it('the nightly reflection is disclosed, and the disclosure is tied to the code', () => {
    // BUG-224. runNightlyConsolidation walks every scope — rep, business, and
    // one per CLIENT — and runReflection posts every active memory statement to
    // the user's AI provider. It is gated on isSalesBrainEnabled() and nothing
    // else, so it fires for someone who never signed in and believes their
    // Sales Brain is local. Nothing in the product said so; the only surface
    // was the Job Inspector, as a raw job-type string.
    //
    // PAIRED rather than pinned alone. A sentence describing behaviour can
    // outlive the behaviour, and then the copy is false in the other
    // direction — a disclosure of something that no longer happens is its own
    // kind of wrong. So the code half is asserted first: if reflection stops
    // sending to the provider, THIS test goes red and asks for the sentence to
    // come out, rather than leaving it there for ever.
    const consolidation = readFileSync(
      join(RENDERER, '..', '..', 'main', 'memory', 'consolidation.ts'),
      'utf8'
    )
    const reflect = consolidation.slice(consolidation.indexOf('export async function runReflection'))
    expect(
      reflect.slice(0, 1200),
      'runReflection no longer sends to the AI provider — the card still says it does'
    ).toContain('completeWithFallback')

    const card = readFileSync(join(RENDERER, 'features/settings/SalesBrainSection.tsx'), 'utf8')
    expect(
      card,
      'the Sales Brain card no longer discloses the nightly pass to the AI provider'
    ).toContain('Once a night it also sends the facts it has learned to your AI provider')
  })
})
