# Verification tooling — read this before driving the app

> **When an investigation needs four corrected instruments, the instruments ARE the
> investigation.** BUG-141 (2026-09-09) needed four: a record buffer that lost records, a CPU
> counter that under-reports 25x here, a Defender counter whose "0.0 s" was access denial, and a
> pending-delete probe Windows made structurally blind. Every one read as a clean result. None
> was caught by reasoning about it — each was caught by deliberately trying to make it fail.
> **Budget for that.** If a session reports a measurement without saying which control proved
> the instrument could go red, the measurement is not yet evidence. The four are written up
> under "BUG-141" below.

## THE TOOLS (M35 Stage 3 — the one index; the lessons below are why each exists)

> **Driving a Monaco editor in a browser (Supabase SQL editor, a web IDE, any in-page code field)?
> Read "DRIVING A MONACO EDITOR IN A BROWSER" at the end of this file FIRST.** Three silent failure
> modes, all producing plausible output, one of them in the exact check you would otherwise reach
> for. The working instrument is `monaco.editor.getModels()[0].getValue()` — never the rendered
> `.view-line` DOM, and never a screenshot.

| Tool | The question it answers | Needs | Run | How it refuses |
|---|---|---|---|---|
| `verify-green.mjs` | Is the branch green? Read from the typecheck's own `error TS` lines and the suite's own `Test Files` / `Tests` lines, never a wrapper's exit or a count beside the answer (species 4, 14, 69). | nothing | `node scripts/verification/verify-green.mjs` (`--tests`, `--types`, `-- <vitest args>`) | prints `VERDICT: NOT GREEN`, exit 1, on any failed/missing summary or a stray `Errors N error` line. Also the CI gate (`.github/workflows/verify.yml`). Self-test: `src/__tests__/verify-green.test.ts`. |
| `tracker-status.mjs` | Does every Bug Tracker entry's status line agree with its body? Regenerates the index at the top of the tracker (species 88). | the vault | `node scripts/verification/tracker-status.mjs` (`--check`, `--migrate`, `--file`) | exit 2 and writes NOTHING when a body has a dated closure later than an OPEN status, a heading still carries a status word, or an entry has no status line. Self-test: `src/__tests__/tracker-status.test.ts`. |
| `state-guard.mjs` (+ `state-guard-selftest.mjs`) | Whatever a drive changes in the real profile is put back by mechanism, not memory — settings AND key files (species 53, 50). | the app's profile | imported by drive scripts: `withRestoredState(...)`; self-test: `node scripts/verification/state-guard-selftest.mjs` | refuses to run a mutation whose target it cannot name unambiguously; the self-test deletes and restores a canary, never a real credential. |
| `cdp.mjs` | Talk to the running renderer over the Chrome DevTools Protocol (dev app `--remote-debugging-port=9333`; the packaged build honours the same flag — confirmed on the Stage 2 VM). | a running app | imported: `connect()`, `evaluate()`, target picking by page URL | throws when the target is ambiguous; never picks "the nearest plausible" page. |
| `ui-driver.mjs` | Drive the UI with every rule below built in: click through the element's real hit-test, wait for PAINT not the port, assert the action CHANGED state. | a running app | imported by drive scripts | `actAndExpectChange` fails when nothing changed; hidden-window timers are named as a limit, not worked around. |
| `screen-sweep.mjs` | Walk every screen of a running build: text a user must never see (raw ids, `undefined`, placeholder copy) and per-screen screenshots hashed in pairs. | a running app | `node scripts/verification/screen-sweep.mjs` | a screen that cannot be reached is reported as unreached, never as clean; identical screenshot pairs fail the theme check. |
| `occlusion-sweep.mjs` | Is any text drawn on top of by something else? | a running app | `node scripts/verification/occlusion-sweep.mjs` | reports the occluded elements by text; an empty DOM is a refusal, not a zero. |
| `purge-test-data.mjs` | Remove only what a drive created in the real profile, by id list, nothing older. | the app's profile | `node scripts/verification/purge-test-data.mjs <ids…>` | refuses ids it cannot find; never touches records not in its list; verifies removal after. |
| `render-surfaces.mjs` / `measure-reach.mjs` | Render a component in the REAL app's stylesheet and theme without a session; can the founder reach every row of a modal at a given viewport? | dev module server | `node scripts/verification/render-surfaces.mjs`, `…/measure-reach.mjs` | measured from `getBoundingClientRect`, reported per viewport; unreachable rows are listed, not summed. |
| `five-checks.mjs` | The five release-feed checks: manifest, hash, staged percentage, installer name, download. | network | `node scripts/verification/five-checks.mjs vX.Y.Z 100` | any check failing prints which and exits non-zero; a missing asset is not a pass. |
| `artifact-version.mjs` | **CHECK 6, added 2026-09-08; second half added 2026-09-09.** Two questions about the built artifact, never about the plan. (a) Does it report the version being released, read from the exe's own ProductVersion? (b) Does it POST-DATE the last commit that touched shipped source? | a built dist/ | `node scripts/verification/artifact-version.mjs 1.11.0` | exits 1 and says DO NOT TAG. (a) was earned by an installer built from merged main that installed cleanly, ran correctly, and reported 1.10.0 because package.json was never bumped — a release that would have reached nobody with every other check green. (b) was earned the next night by the opposite shape: a rebuild exited 1 partway through, the wrapper reported "BUILD DONE, version 1.11.0" after reading it out of the `latest.yml` the failed build never rewrote, and (a) then passed over an artifact 67 minutes OLDER than the fix it was supposed to carry. Version-correct is not the same as current. Compared against shipped source rather than HEAD on purpose — against HEAD it fails on every test-only commit and demands a rebuild that cannot change a byte, and a check that cries wolf on correct states is one people learn to wave through. **CAVEAT on (b), and it matters: it compares file MTIME.** That is the build time for a LOCAL artifact and the DOWNLOAD time for a fetched one — so against anything you just downloaded it always passes, over any binary at all, and is not evidence of anything. Only (a) means something there. The script prints this in its own output when `--exe` names a file written in the last hour. To ask whether a SHIPPED artifact is current, read the release run's `headSha` instead: `gh run view <id> --json headSha`. |
| `sweep-record.mjs` | **THE RAMP NUMBER.** Reads the BUG-215 quote sweep's record out of a profile and gives a verdict on `rescuedByFileCheck` — the M37 ramp criterion. | any userData profile | `node scripts/verification/sweep-record.mjs [profile]` | five outcomes, distinct exit codes, red-checked against synthetic profiles for each: **MEANINGFUL ZERO** (0 over a non-empty population — exit 0, ramp supported), **TRIVIALLY ZERO** (`callsSwept` 0, so the guard was never exercised — exit 2, NOT evidence), **STOP THE RAMP** (non-zero — exit 1), **SKIPPED**, **HAS NOT RUN**. It refuses to print a bare number, because a zero over an empty population is the absence of evidence wearing a green tick. Also detects a record with NO `rescuedByFileCheck` field — written by a build predating BUG-236 — and says *absent is not zero*. |
| one-offs: `bug141-fsync-probe.mjs`, `bug176-corpus-check.mjs`, `bugd-partition.mjs`, `drive-call-deal-picker.mjs`, `bug237-erase-drive.mjs` | evidence for a single bug, kept because the tracker cites them | varies | see each file's header | — |

**Which ones CI runs:** only `verify-green.mjs` (and the instruments' own self-tests). Everything
that needs a running app or the founder's profile is run by a session, by hand, and its result
is pasted into the tracker with the screenshot hashes — see "THE SECOND RULE" below.

**Two rules added 2026-09-06, each after the failure that earned it:**

- **Never `Stop-Process` / `taskkill` anything named electron, CallRiseAI or node by hand.** Use
  `node scripts/verification/protected-instances.mjs --list | --stop-sandboxes | --stop <pid>`.
  It refuses the founder's dev app (the writer on 9333), its children, the dev server and the
  installed app unless you pass `--i-asked-the-founder` — a phrase, not a flag, so it cannot be
  passed by habit. Why: three months of "one writer" as a convention produced two violations; the
  second (2026-09-06 00:50) killed the dev app with a path-matched sweep meant for a sandbox. Self-test:
  `src/__tests__/protected-instances.test.ts` runs that exact sweep against fake rows.
- **Never write code through a shell heredoc.** Use the file tool (Write/Edit). Why: four times in
  one night a heredoc turned an escape into a real character — a backslash-b into a backspace byte inside a
  regex, a backslash-n into a newline inside a string — and the file parsed nowhere or matched nothing.
  `src/__tests__/no-control-bytes-in-source.test.ts` catches the byte; this rule prevents the hour.

**The three rules in one line each:** an instrument that writes names its target and refuses
when it cannot (species 53); test the instrument's refusals before trusting its results
(species 79); read the answer, not a number next to it (species 69).

---

Two small modules for verifying behaviour against a **running packaged build**,
plus the rule that matters more than either of them.

## The rule

> **An instrument that WRITES must name its target explicitly and refuse if it
> cannot identify it unambiguously. And every guard runs BEFORE every mutation,
> including the setup ones.**

Reading the wrong thing produces a wrong answer you can catch. Writing the wrong
thing produces damage you can't. This is taxonomy species 53; both halves of it
were learned the expensive way on 2026-08-30:

- A script needed the Groq key field. It walked up from each `<input>` looking
  for an ancestor mentioning "Groq" — and the **first input on that page is
  Deepgram's**, whose ancestors include the "Default text AI provider" card that
  lists Groq as a button. It typed a fake key into the Deepgram field and saved.
  The founder's real Deepgram key was gone: no `.env` copy, no `.bak`, and the
  app's backup covers calls/contacts/deals but **not `ai-keys`**.
- A later script did the targeting correctly, then set `aiProvider` as SETUP
  *before* running its refuse-checks. One refused, the script exited, and the
  founder's default was left on a keyless provider. **A refuse-check that runs
  after a write is not a guard, it is a post-mortem.**
- That leftover default is then what made BUG-143 fire on the founder's own
  machine when they typed `junk` into a card: the app auto-selected a rejected
  key, exactly as the bug describes.

Three incidents, one root: *state was mutated to set up a check, and restoring
it was something someone had to remember.*

## `state-guard.mjs`

Restoration as mechanism rather than memory. `withRestoredState(fn, opts)`:

- snapshots `app-settings.json` and a content hash of every file in `ai-keys/`
  **before anything runs**
- restores in a `finally` — including on throw and on refuse-and-exit
- **reads the state back afterwards and asserts it matches the snapshot**
- reports loudly, with the specific files, when it does not

`allowKeyChanges: ['MISTRAL_API_KEY']` names key files the check is *expected*
to touch. Anything outside that list appearing in the diff is reported as a
failure — which is precisely the class of mistake the first incident was.

It suppresses the FAILURE REPORT for those files; it does **not** leave them
behind. Every key file is restored either way — a throwaway credential saved by
a check is deleted on the way out, because cleaning it up by hand is exactly the
"something I have to remember" this module exists to delete. (M32 did have to
remember it, once, before the restore existed.)

```js
import { withRestoredState } from './state-guard.mjs'

await withRestoredState(async () => {
  // ... your check. Mutate freely; it comes back.
}, { allowKeyChanges: ['MISTRAL_API_KEY'] })
```

It deliberately snapshots more than any single check needs, because the failure
being prevented is exactly *"I didn't think that piece of state was in scope."*

## `cdp.mjs`

A minimal Chrome DevTools Protocol client for reading state out of the running
renderer. Launch the app with `--remote-debugging-port=9222`, then
`connect(9222)`.

Use it for anything a screenshot cannot settle — a still image of a UI is
identical whether `prefers-reduced-motion` is on or not; a computed style is
not.

**It pins the main window and refuses otherwise.** The app publishes two page
targets with the *same* title (the main window and
`index.html#/detection-overlay`), and `/json/list` orders by recent activity
rather than identity — so `pages[0]` is not a stable reference to anything. It
selects by URL and throws if it cannot find exactly one main window. Same
"refuse, don't guess" shape as the rule above, one layer down.

## Choosing a target in the UI

Locate by something that **can only mean one thing**. On the API keys screen
that is the exact placeholder (`Paste your Groq API key`) — 13 inputs, 13
distinct placeholders, verified read-only before writing anything. Require
exactly one match and refuse on zero or many, printing what you found.

For a Save button: require the **one** `Save` in the smallest ancestor that
holds no other key field. Anything else is ambiguous — refuse.

## Verifying you are driving the build you think you are

Pick a string introduced by the exact commit under test and **confirm it is
absent from the previous build first**. A marker you have not verified is
absent proves nothing.

On 2026-08-30 `validationReason` worked (`git log -S` attributes it to one
commit, and it was absent from the prior asar). `Key invalid` would have been
useless — it predates the change and was already shipped.

## Driving the app: three things that cost a session on 2026-08-31

### `element.click()` can report success and do nothing

The third instance of this shape, so it is written down rather than rediscovered.
A CDP `Runtime.evaluate` that finds an element by text and calls `.click()`
returned `CLICKED` — and the page did not move. The match was a wrapper element
that has no handler; the real one is a child.

**Dispatch a real mouse event at the element's own centre, and read state after
every click that matters.**

```js
const r = el.getBoundingClientRect()          // from inside the page
// then, from the driver:
for (const type of ['mousePressed', 'mouseReleased'])
  await cdp.send('Input.dispatchMouseEvent',
    { type, x: r.x + r.width / 2, y: r.y + r.height / 2, button: 'left', clickCount: 1 })
```

And compare something real before/after — `document.body.innerText.slice(0, 80)`
is enough. **Do not compare a slice that is the same on both pages**: the first
version of this check compared the first 60 characters, which are the settings
shell header on every settings page, and reported "changed: false" for a
navigation that had in fact worked. A control that cannot distinguish the two
states is not a control.

### Identity: pin the page URL, not a marker string

The strongest available proof that you are driving YOUR build is the page's own
URL. `connect()` returns `page.url`; a dev build reports
`file:///C:/Users/User/Desktop/<worktree>/out/renderer/index.html`, which the
installed app cannot produce. **A path cannot be coincidentally present the way
a string can** — prefer it over a `git log -S` marker, and keep the process
start-time check as the second half.

### The app CANNOT run beside the installed copy — do not spend an hour on it

Three attempts, all wrong, in order:

1. `npm run dev -- --user-data-dir=...` — `electron-vite`'s CLI rejects unknown
   options outright.
2. `electron out/main/index.js --user-data-dir=...` — the switch lands AFTER the
   app path, so Electron passes it to the app instead of consuming it.
3. `APPDATA=<temp> electron ...` — `app.getPath('appData')` reads the Windows
   shell API, not the environment variable.

None of them can work, and the reason is in the source: `src/main/index.ts`
does `app.setPath('userData', join(app.getPath('appData'), 'sales-os'))`. The
path is **hardcoded**, so every instance shares one userData and therefore one
single-instance lock. A second instance calls `app.quit()` before `whenReady`.

**So a live drive means closing the founder's running app, and it runs against
their REAL data.** Ask first — and snapshot `ai-keys/` with per-file hashes plus
`app-settings.json` before anything, then verify byte-identity afterwards. Read
only: no typing into a key field, no Save, no Remove, no toggles.

### The target below the fold: a click that lands on nothing

Third driving defect from the same session, and the easiest to miss because it
produces **no error at all**.

`getBoundingClientRect()` returns viewport coordinates. An element further down
a scrolling page has a `y` **outside the window**, and
`Input.dispatchMouseEvent` at that point hits nothing — no exception, no
warning, and the next screenshot looks plausible. The API keys page has twelve
cards; the ninth was nowhere near the viewport, so the click and the
`Input.insertText` after it both went into the void. Only reading the input's
`.value` back caught it.

**Scroll first, measure second, and refuse if it is still not on screen:**

```js
el.scrollIntoView({ block: 'center' })
const r = el.getBoundingClientRect()
if (!(r.y > 0 && r.y < innerHeight)) return { err: 'off-screen after scrollIntoView' }
```

Refusing matters as much as scrolling: a sticky header, a modal or a collapsed
section can each leave the element unreachable, and clicking anyway is how a
driver silently operates on the wrong thing.

### Assert that your action CHANGED the state, never that the state matches

Third instance of this family, and the cheapest one to prevent.

M32's visual pass clicked **Light**, then asserted `/light/.test(rootClass)`. It passed.
The app **was already in light theme** — the click changed nothing, the assertion
confirmed a state that pre-existed it, and the run reported a successful theme
switch. The consequence went further than the check: every screenshot shown to
the founder up to that point was light, while both of us believed a two-theme
pass was underway. **Dark had never been rendered.**

```js
const before = await rootClass()
await click('Dark')
const after = await rootClass()
if (before === after) throw new Error('the click was a no-op')   // ← the control
if (/(^|s)light(s|$)/.test(after)) throw new Error('still light: ' + after)
```

**Read the state, act, read it again, and assert on the DIFFERENCE.** Asserting
the end state alone cannot tell "my action worked" from "it was already like
that" — and the second is silent, plausible, and produces screenshots that look
exactly like success.

Same family as *a click that reports success and does nothing* and *a target
below the fold*: in all three the action never happened and nothing said so. The
difference here is that the check itself supplied the false confirmation.

## The driver's own rules, and two constraints that are not niceties

`ui-driver.mjs` exists so these are behaviour rather than memory. Three of them
were learned by breaking, one after the other, in a single afternoon.

### Test the instrument's REFUSALS before trusting its results

Every driver run should begin by asking it to locate something that does not
exist, and confirming it **refuses**:

```js
for (const desc of [{ text: '__no_such_control__' }, { placeholder: '__no_such_field__' }]) {
  try { await ui.locate(desc); console.log('*** FAILED TO REFUSE ***') }
  catch { console.log('refused:', JSON.stringify(desc)) }
}
```

**An instrument that has not been shown to fail is one you are taking on faith**
(species 37, and the founder's standing property as of 2026-08-31). It costs two
calls and it is the difference between "the check passed" and "the check ran".

### WORKED EXAMPLE: the comparison that cannot tell the two states apart

The rule *"assert the state CHANGED"* is not enough on its own — **what you
compare has to be capable of changing.**

Real sequence, same day the rule was written down:

```js
// WRONG — and it reported a successful navigation as a no-op
() => ui.evaluate('document.body.innerText.slice(0, 120)')
```

The first ~120 characters of this app are the **sidebar**, which is byte-identical
on every screen. The navigation had worked; the comparison could not see it. The
inverse of the same mistake (comparing a slice that is identical across screens
and concluding *nothing changed*) is what made an earlier pass report "changed:
false" for a click that had landed.

```js
// RIGHT — compare the whole page, and compare a HASH of it (see below)
const pageHash = async () => {
  const t = await ui.evaluate('document.body.innerText')
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0
  return `len${t.length}:h${h}`
}
```

**Before using any before/after value, ask what it looks like on the OTHER screen.**
If you cannot say, it is not a control.

### CONSTRAINT, not a nicety: a verification tool must not become a place the data ends up

**Compare hashes, never text. Never print page content on failure.**

The natural implementation prints "the value that did not change" when an
assertion fails — and on this app that is the founder's real contacts, deal
titles and call subjects. **It did exactly that, into a log, twice**, before the
truncation in `actAndExpectChange` existed.

This is a standing constraint (founder, 2026-08-31): *anything that reads my data
to verify it must not become a place my data ends up.* Practically:

- compare a hash or a length, not the text itself;
- when you must read text, read the smallest region that answers the question
  (`cardText(placeholder)` rather than the whole body);
- assume every error message you write will be pasted somewhere.

### Wait for PAINT, not for the port

`openApp` polls until the body has real content. CDP answers long before React
renders, and a locator run too early reports **"expected exactly 1 match, found
0"** — which reads exactly like a missing feature rather than an early call. A
driver that can report a shipped control as absent is worse than a slow one.

---

# THE SECOND RULE — added 2026-08-31, M32 Stage 2

> **Assert on the property that would be WRONG if the feature were broken, not
> on the mechanism that is supposed to produce it.**

This is the third time in one milestone that a check passed by asserting on a
proxy for the thing instead of on the thing. The founder named it after the
worst instance, and it is worth stating as bluntly as it happened.

## The theme check that reported two identical screenshots as a light/dark pass

The claim made to the founder was: *"verified in both themes."* What actually
happened, in three stacked errors:

1. **There is no `dark` class.** `useTheme.ts` does
   `classList.toggle('light', resolved === 'light')` — dark is the *absence* of
   a class. The harness added a `dark` class, which styled nothing at all.
2. **The substring test for `'light'` matched `first-light`** — the
   design-preview class — so a dark app was read as being in light mode.
3. **The assertion then passed on the junk class the harness had just added
   itself.** `before !== after` was true, because the harness had mutated
   `className` and then compared `className`.

Result: two byte-identical dark screenshots, reported as a two-theme pass. The
class is a **proxy** for the theme. The rendered colour **is** the theme:

```js
const bg = () => ev('getComputedStyle(document.body).backgroundColor')
// rgb(13, 12, 10) -> rgb(255, 254, 252). If that number does not move,
// nothing moved, whatever the class list says.
```

The same rule catches the other two instances from this milestone: a
`/light/.test(rootClass)` check that passed because the app was *already* light
(no control), and a demotion assertion that measured demotion and inferred
reordering. In all three the mechanism was inspected and the outcome was not.

## Corollaries, each paid for on 2026-08-31

### Hash every screenshot pair. Always.

An opaque probe host at `z-index: 99999` sat on top of the very dialog it was
meant to display. `innerText` read the modal **perfectly** — every row, every
button — while the modal was invisible to any human looking at the window. Two
screenshots came out byte-identical at 7128 bytes: a flat sheet.

**A text assertion can confidently describe something no user can see.**
Comparing the screenshot *hashes* is what caught it. `sha256sum a.png b.png` —
if two shots that should differ are identical, stop and look before writing a
word about either.

### Anything a harness creates, it must verify it REMOVED

`Modal` renders through a portal to `document.body`. Removing the probe's host
`div` therefore removed nothing: each run left its dialog mounted, and three
runs stacked three dialogs. The row count went **15 → 45** while every
structural assertion kept passing — on the pile.

Same shape as module-global state leaking between tests. Removing is not
cleaning up; **verifying the removal** is:

```js
// unmount the root (a portal outlives its host div), then PROVE it is gone
if (window.__root) { window.__root.unmount(); window.__root = null }
host.remove()
// ...and assert no stray artefacts remain, or the next run measures a pile
if (strayAnswerButtons > 0) throw new Error('cleanup left something behind')
```

### A fallback that widens what counts as success can launder a failure

Because the modal portals away, reading `host.innerText` gave **0 chars for a
dialog that had rendered perfectly**. The fix — fall back to `document.body` —
also made a genuinely *blank* host pass, because the login screen underneath is
~90 chars and cleared the 60-char threshold.

**A length check cannot tell "my component" from "whatever was already on
screen."** Capture a baseline *before* the render and require the page to have
GAINED content.

### "It is in the DOM" is not "the user can click it"

The backfill's structural check reported *"every row has all five answer
buttons"* — true, and true of rows **no user could reach**. The dialog was
1261px tall in an 816px viewport at `top: -223`, with nothing scrollable
anywhere in the ancestor chain: **3 of 15 rows were physically unclickable.**

For anything the user must operate, measure operability, not presence:

```js
el.scrollIntoView({ block: 'center' })
const r = el.getBoundingClientRect()
const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
const clickable = hit === el || el.contains(hit)   // NOT just "el exists"
```

Note the second half: `elementFromPoint` is what catches the element being
*covered*. A bounding box inside the viewport is still not a click that lands.

---

# TECHNIQUE — verifying a visual change when auth blocks the app

**2026-08-31.** The founder was away, the signed-in app was unreachable, and a
sandbox profile (a copy of the data with no credentials) stops at the login
screen. Seeding a session meant copying the profile's encryption key, which the
permission layer correctly refused.

The app is running **Vite in dev mode**, which serves every source module on
demand. So the components can be imported into the live page and mounted
directly — no session required:

```js
// Bare specifiers do not resolve in a page context, and the ?v= hash goes
// stale. Discover the dep URLs from the entry module the app already loaded.
const entry = await (await fetch('/src/main.tsx')).text()
const findUrl = (needle) => {
  const i = entry.indexOf(needle)
  const q = String.fromCharCode(34)
  return entry.slice(entry.lastIndexOf(q, i) + 1, entry.indexOf(q, i))
}
const React = (await import(findUrl('/deps/react.js'))).default        // CJS interop
const { createRoot } = (await import(findUrl('/deps/react-dom_client.js'))).default
const C = await import('/src/features/deals/OutcomeInsightCard.tsx')
createRoot(host).render(React.createElement(C.OutcomeInsightCard, props))
```

Three things to know before reaching for it:

- **The renderer's Vite root is `src/renderer`**, so the module path is
  `/src/features/…`, NOT `/src/renderer/src/features/…`. The wrong path returns
  **200 with index.html**, not a 404 — so `curl -o /dev/null -w %{http_code}`
  says nothing. Look at the first bytes of the body.
- **Main-process IPC works.** `window.api.*` is live, so a component that
  fetches its own data renders with REAL data. The backfill dialog showed the
  founder's actual 15 rows this way.
- **It is not an end-to-end pass, and must not be reported as one.** The
  component is mounted directly rather than reached by navigating the app, so
  it says nothing about whether the parent view places it, or about what a
  click does. Pair it with a main-process test for the write path.

This found a real defect on its first outing — see `docs/M32-stage2-outcome-tracking.md`,
"THE DEFECT ONLY RENDERING FOUND". `render-surfaces.mjs` is the worked example.

---

## SILENT REGEX CORRUPTION IN EVALUATED CODE — 2026-09-01

**Backslashes are eaten passing through a template literal into CDP, and the
result usually still RUNS.** That is what makes it dangerous: a syntax error
announces itself, a corrupted-but-valid regex does not.

Observed, in one session:

| written | arrived as | effect |
|---|---|---|
| `/s+/g` | `/s+/g` | stripped every letter **s** — `"Calls"` became `"call"`, `"Past"` became `"pa t"`, `"Settings"` became `"setting"`. Every comparison silently failed and the driver reported "found 0" for controls plainly on screen. |
| `/[ 	

]+/g` | `/[ tnr]+/g` … then unparseable | `SyntaxError: Invalid regular expression` — the loud, harmless version |
| `.` inside a class | `.` | class matches far more than intended |

The first row cost the most: it produced a **plausible wrong answer**, not an
error. A driver that says "found 0" reads exactly like a missing feature.

**Rules for anything inside an `evaluate()` template:**

1. **No regex literals at all.** Use `indexOf`, `startsWith`, `===` on
   lowercased strings. Substring matching needs no escapes.
2. If a regex is unavoidable, build it with `new RegExp` from a string
   assembled via `String.fromCharCode` — never a literal with backslashes.
3. **No `?.` or `??`** either — both have been mangled the same way, turning
   `React.default?.createElement` into a silent undefined.
4. When a selector reports **0 matches for something you can see on screen**,
   suspect the escaping before suspecting the app. Print the raw strings the
   page actually holds and read them: `"ri e"` and `"pa t"` in a button list
   are the fingerprint.

Sibling to the "assert on the outcome, not the mechanism" rule: here the
mechanism (the regex) is silently different from the one you wrote, so every
assertion built on it is describing a different question than the one asked.

## `screen-sweep.mjs` — the broad question

Every other probe in this directory asks a narrow question and answers it well.
`screen-sweep.mjs` asks the one that caught **BUG-163**: *does this screen look
right?*

It walks 27 states (every top-level screen, two call detail pages, all nineteen
settings sub-pages) and reports two things per state: text a user should never
see (`null`, `undefined`, `NaN`, `[object Object]`, an unrendered `{{template}}`)
and any console error or exception.

```
node scripts/verification/screen-sweep.mjs
```

Exit 0 = clean; 1 = something was found; 2 = no app; **3 = it refused to
report**.

That exit 3 is the point of the script. BUG-163 was a contact literally named
`null`, auto-created and auto-linked to nineteen calls, sitting at the top of
the CRM — and it was found by a human looking at a screenshot taken to check
something else, while every automated probe reported success. So this script
does not trust itself either. Before it reports anything it:

- plants a `console.error` and refuses unless its own hook sees it;
- plants five known defects **and three innocent lookalikes** — `Cannula
  supplier`, `Annulment notes`, `Nunes Holdings`, all of which a substring
  match would eat — and refuses unless it catches exactly the five and none of
  the three;
- refuses if it cannot clean up its own canary nodes afterwards.

**A probe reporting zero is a claim about the probe until proven otherwise**
(species 66). A row of zeros from a sweep that never navigated anywhere looks
exactly like a clean app; the first version of this script produced one,
because Settings replaces the sidebar and every later click matched nothing.
Hence the `SKIP` marker, the `states visited` count, and the `Back` at the top.

It only ever READS. It clicks navigation and nothing that writes.

## `occlusion-sweep.mjs` — is anything drawn on top of the words?

Two real bugs in this repo were exactly this, and both survived review:
**BUG-158** (the Live Deal Intelligence panel mounted over the transcript) and
**BUG-165** (the coaching-cue rail drawn THROUGH transcript text at every
window width below 1280). In both, every element was inside the viewport and
the layout probe reported the screen clean. **Bounds are not occupancy.**

```
node scripts/verification/occlusion-sweep.mjs [--width 1280]
```

Exit 0 = nothing occluded, 1 = something is, 2 = no app, **3 = it refused**.
It plants a div that genuinely covers a sentence and refuses to report unless
it finds it, then cleans up and refuses if it cannot.

**The false positive it exists to avoid.** A naive version flagged three
elements on the Calls screen as "covered by `<header>`". They were not — they
were half-scrolled past the top edge of a scrolling container.
`getBoundingClientRect` does **not** clip to an overflow ancestor, so a
partly-scrolled row reports a rect whose centre lands in the window's drag
strip, and `elementFromPoint` dutifully returns the header. Every candidate is
now intersected with the visible box of each scrolling ancestor first.

**What it still flags that is fine.** A floating affordance that deliberately
sits over content — the jump-to-bottom chevron is the example, and it is over
content on purpose (the founder asked for the Claude-style button that stays
reachable from any scroll position). Read the hits; do not treat a non-zero
count as a defect count.

## `purge-test-data.mjs` — undo what driving the app costs

Driving the app against the real profile is the only way some bugs get found —
BUG-163 through BUG-167 all came from it. It is not free. One overnight session
left **48 synthetic calls and 24 auto-learned memories** on the founder's
profile, and they were not inert:

- the top row of **Coaching → Scorecards**, i.e. "your most recent
  performance", was a synthetic 49-second call scored 33;
- **Your Trend**'s *"Down 7 points from your first tracked week to your
  latest"* was measuring the latest week against test data;
- **Performance** reported *"237 calls … you're picking up the pace lately"*,
  and the pace was the test harness.

```
node scripts/verification/purge-test-data.mjs --since 2026-09-01T18:00:00.000Z
node scripts/verification/purge-test-data.mjs --since 2026-09-01T18:00:00.000Z --apply
```

**There is no default cutoff, and it exits 2 without one.** Guessing which of
someone's data is disposable is not a decision a script gets to make. Dry run
unless `--apply`, and it prints everything it would touch first. Calls are
tombstoned (`deleted: true`) the way the app itself deletes them rather than
unlinked, so nothing referencing them breaks; memories are matched on
`created_at` only, so anything written before the cutoff is untouched.

---

# THE THIRD RULE — added 2026-09-02

## "Is this branch superseded?" — the obvious command answers a different question

Deleting a stale branch is routine, and the check people reach for is:

```
git diff main...branch          # ← WRONG QUESTION
```

Three dots means *"what did this branch change since the merge base."* That is
**not** "what does main lack." The two look like the same question and are not:

- A branch whose fix reached main **by another route** — cherry-picked,
  rebuilt, rewritten under a different branch name — still shows its whole diff.
  You read that as "unique content" and keep a branch that is genuinely dead.
- Worse, the reverse: the command tells you **nothing** about content main is
  missing, so a branch you think is empty can be holding files nobody else has.

Both happened here on 2026-09-02 in a single check, on four branches:

- `hotfix/telemetry-anon-upsert-rpc` showed a 147-line diff including a whole
  SQL file. Main already had all of it (`68fc1d0`, PR #8, from a differently
  named branch). It was safe to delete and the command said otherwise.
- `claude/overnight-audit` was reported to the founder as superseded. It held
  **802 lines of audit findings, two recorded decisions and a handoff that
  existed nowhere else.** Deleting on that report would have destroyed them.

### Ask the right question

```
git cherry -v main origin/<branch>     # '+' = change NOT in main, '-' = already there
git diff --diff-filter=A --name-only main origin/<branch>   # files ONLY on the branch
```

`git cherry` compares **changes**, not commits, so a cherry-picked or rebased
commit is correctly reported as already present. The `--diff-filter=A` listing
is the other half: it names files that exist on the branch and not on main,
which is the thing that actually gets destroyed by a delete.

### And `git cherry` is not the last word either

It compares patch **text**. Two independent fixes to the same defect, written
differently, both read as unique. `fix/rescue-steps-unhandled-rejection` was
reported as one unique commit; main already had a working fix for that exact
leak, written by someone else eleven days earlier. Only reading the conflict
settled it.


**And when you do read it, resolve on which half cannot be regenerated.** Both
fixes to that leak were correct and equivalent; main's sat in a `finally`, the
branch's at function entry. The code was the interchangeable half. What the
branch had and main did not was the explanation of the FAILURE SHAPE — every
assertion passing while Node reports an unhandled rejection on a later,
unrelated test, because `.final` rejects a microtask after the generator's throw
is already handled. A failure that accuses the wrong file, non-deterministically.
Someone can rewrite the fix in a minute. Nobody is going to rediscover that.

So the merge kept main's implementation and took the branch's comment — and
rewrote the comment's last line, which described settling `.final` at function
entry, because main does it in a `finally`. **A comment describing an
implementation that is not there is the exact gap this directory is about**, and
it is easy to import one while congratulating yourself for preserving knowledge.

**So: `git cherry` to narrow, then read what is actually different.** A count
is a filter, never a verdict.

## The same check, one line later: a substring match is not a file check

In the same investigation, `git ls-tree -r --name-only main | grep -ci handoff`
returned 1 and was read as "main has `docs/HANDOFF.md`." It had matched
`docs/M27-tier1-recorder-handoff.md`. Main did not have the file.

```
git ls-tree -r --name-only main | grep -cx 'docs/HANDOFF.md'    # -x, anchored
```

Two bad instruments inside one check, both caught only by looking at what they
matched. That is the whole thesis of this directory: **an instrument's output is
a claim about the instrument until you have seen what it looked at.**

## Render tests exist — the recipe (correction, 2026-09-05)

For weeks this project believed "no component in this app can have its render
output tested" (BUG-140) and shaped decisions around it: logic pushed into
`.ts` files with thin JSX, and "verified by tests, not by render" accepted as a
limit in half a dozen reports. **It was false.** Two suites already render real
components under vitest:

- `src/renderer/src/features/live/__tests__/live-header-pieces.render.test.ts`
- `src/renderer/src/features/tasks/__tests__/GenerateTasksDialog.recovery.test.ts`

The recipe: a `.test.ts` file (the runner's `include` is `src/**/*.test.ts`),
`// @vitest-environment happy-dom` on line 1, `createRoot` from
`react-dom/client`, `act` + `createElement` from `react`, and
`IS_REACT_ACT_ENVIRONMENT = true`. Anything that provides context at the app
root (toasts, the tooltip provider) must either be wrapped in or self-provide —
the tooltip primitive does the latter precisely because these suites found it.

How it surfaced is worth keeping: a commit message claimed a green suite by
reading the wrapper's exit code instead of the suite's; the seven real failures
underneath were these render suites breaking on a missing provider, and chasing
them found the belief. A false claim exposed a false belief; neither would have
surfaced without the other (taxonomy species 82).

## Read the answer, not a number next to it (species 69, three instances in two days)

The same misreading happened three times on 2026-09-04/05: a wrapper's exit
code taken as the suite's ("exit 0" over 7 failures), a `grep -c` count taken
as content, and a typecheck's "1" read as clean. Counts sit NEXT to the answer
and look like it. The mechanical fix is one command that prints the answer in
the only form that cannot be misread and ends with one word:

```bash
node scripts/verification/verify-green.mjs
```

It runs the project's typecheck and the full suite and prints the suite's OWN
`Test Files` / `Tests` summary lines, the typecheck's OWN `error TS` lines,
every `×` test name, and `VERDICT: GREEN` or `VERDICT: NOT GREEN`. Its exit
code is its own (nothing is piped through `head` or `tail`). `--tests -- <files>`
narrows the suite; `--types` runs the typecheck alone.

Rules that follow from it, for anything this script does not cover:

- never `| grep -c` a gate — print the matching lines, or none;
- never read `$?` after a pipe — the last command's code is what you get;
- when a command prints a count, print the thing counted next to it.

---

# DRIVING A MONACO EDITOR IN A BROWSER — three silent failures in one tool

**Added 2026-09-07, from running a production Supabase migration.** This applies to any Monaco
editor reached through a browser: the Supabase SQL editor, VS Code in the browser, a web IDE, an
in-page code field. It cost most of an hour and would have cost a wrong migration.

**The meta-finding first, because it is the part that generalises.** Three distinct failure modes,
in one tool, in one sitting. All three were **silent**. All three produced **plausible output** —
the tool reported success and the screen looked right. That is not a flaky editor. That is an
instrument that cannot be trusted without an independent read, and the independent read has to come
from somewhere other than the surface you are driving.

## The working instrument, first

```js
monaco.editor.getModels()[0].getValue()
```

`monaco` is a page global wherever Monaco is embedded. This returns the editor's **logical model**:
exactly the text that will be submitted, with the editor's own line endings (`\r\n`). Compare THAT
against your intended text, programmatically, before you act. Everything below is a reason not to
use anything else.

## 1. `Ctrl+A` does not reach Monaco — so select-all-then-type APPENDS

Pressing `ctrl+a` and then typing looks like a replace and is an **append**. The keystroke is
reported as delivered; the selection never happens.

Measured: after `ctrl+a` + `Delete` + typing a new statement, the model held
`create policy "p" …;create policy "x" …` — the previous probe still there, the new text glued to
its end with no separator.

**What to do instead:** navigate to a fresh editor URL for a clean model rather than trying to
clear one. Reloading is reliable; clearing is not. If you must clear, verify the model is `''`
before typing.

*(This is the same failure recorded in M32, where `ctrl+a` and `ctrl+End` silently failed to reach
Monaco and appended a REVOKE onto an unrelated SELECT. It has now cost two sessions.)*

## 2. Auto-indent rewrites your whitespace — typed multi-line text is never what you typed

Monaco indents continuation lines itself, **on top of** the indentation in the text you send. Type
four spaces after an open paren and you get six; type two before a closing paren and you get eight.

Measured, typing `\n    a = 'b' …\n  );`:

```
  for delete using (
      a = 'b' and (f(n))[1] = c      <- 6 spaces, 4 were sent
        );                            <- 8 spaces, 2 were sent
```

For SQL this is cosmetic. For anything whitespace-significant — YAML, Python, a Markdown code fence
— it is a corruption. And it defeats a byte-for-byte comparison against a source file even when the
meaning is identical.

**What to do instead:** send text with **no leading whitespace and one logical statement per line**,
so auto-indent has nothing to add. Derive that form mechanically from the source file rather than
retyping it, and say plainly that the comparison is against the derived text.

## 3. The rendered DOM shows a soft wrap as a real line break — RECORD THIS ONE HARDEST

`document.querySelectorAll('.view-line')` returns one node per **rendered** line, not per logical
line. With word wrap on, a single long statement spans several `.view-line` nodes, and joining them
with `\n` inserts newlines **that do not exist in the document**.

Measured, on one 68-character statement typed as a single line:

```
DOM lines  : "…(f(n))[1] \n= c);"     <- a newline mid-statement
model value: "…(f(n))[1] = c);"        <- the truth
```

**This is the one that matters**, and it is why it is recorded hardest: reading `.view-line` is the
check a careful person reaches for. It is the DOM, it is the real text on screen, it feels like
ground truth. It would have reported a difference that did not exist, on a production migration —
and had the wrap fallen elsewhere it would have reported a match that did not exist. A confident
wrong answer from the very instrument chosen to prevent one.

A screenshot is worse again: it shows the same wrapped rendering, plus it lags. During this session
the screenshot showed a placeholder for an editor that already contained text.

## The procedure, for a migration or anything else that must be exact

1. Navigate to a **fresh** editor URL. Confirm `getValue() === ''`.
2. Click the editor by its accessibility ref, then confirm
   `document.activeElement.classList.contains('inputarea')`.
3. Type the text, one logical statement per line, no leading whitespace.
4. Read `monaco.editor.getModels()[0].getValue()` and compare **programmatically** — not by eye,
   not from a screenshot, not from `.view-line` — against text derived from the committed source.
5. Only then act. If the comparison fails, or if any input reported success and did not land, stop
   and hand it back rather than retrying.

Step 4 is the whole point. Steps 1–3 are workarounds for failures that will probably differ in the
next editor; step 4 is what makes any of them survivable.

---

## DRIVING A WINDOWS VM OVER RDP — four hazards, none of which appears in any log

*Added 2026-09-08, after the M37 release walk. Four instruments failed at once on the Stage 2 VM;
each was individually findable and together they cost hours. **Three of the four are ENVIRONMENT,
not code**, which is why nothing in the repo could have warned about them and why they belong here.*

**Start every VM session by running the four checks below before driving anything.** They take a
minute together. Skipping them does not fail loudly — it produces keystrokes that arrive as
different characters, paths that silently do not exist, and a script that parses fine on the host
and fails on a brace forty lines from the real problem.

### 1. The guest's keyboard layout rewrites your keystrokes

The Stage 2 VM has **Hebrew (Standard)** installed alongside English. With Hebrew active, SendKeys
text arrives transposed: `E`→`ⴰ`, `B`→`J`, `U`→`Ⴑ`, `/`→`q`, and `[`/`]` swap. `powershell
-ExecutionPolicy Bypass` typed as `powershelll -ⴰxecutionⲆolicy Jypasss`. Nothing errors — the shell
simply reports an unknown command, which reads like a missing binary.

**Check:** look at the tray for `ENG` vs `עבי` before typing, and type a canary first —
`echo HELLO-TEST-123` — and READ IT BACK from a screenshot.

### 2. Windows tracks the layout PER WINDOW, so fixing it once fixes one window

Switching to ENG with PowerShell focused leaves Explorer on Hebrew. The next path typed into
Explorer's address bar came out as `qqtsclientqcqusers…` and opened Edge.

**Check:** re-verify the layout after every window switch, not once per session. This is the one
that turns "I fixed that" into an hour, because the fix is real and its scope is not what you assume.

### 3. Punctuation does not survive SendKeys even on ENG

Measured on that VM with ENG active: alphanumerics, `\`, `-`, `.`, `;`, `:` arrive intact.
`[ ] ( ) ' " { }` do not — brackets transpose, quotes and parens vanish. `$d=[char]92` arrived as
`$d=]char[92`.

**Check:** keep typed commands to alphanumerics, backslashes, hyphens and dots. Anything needing
quotes, brackets or parentheses goes in a **file** that is invoked by path, never typed inline. A
`.bat` next to the script, launched by double-click or by typing only its path, removes the problem
entirely — `%~dp0` gives the script its own directory so nothing has to be escaped.

### 4. Your own host-side quoting eats backslashes before they reach the VM

Independent of the VM. `-Type "…\\tsclient\…"` from a bash-quoted command arrives as
`\tsclient\`, so every UNC path fails with "cannot find path C:\tsclient" — which reads exactly like
drive redirection being off, and sends you to check the wrong thing.

**Check, measured rather than reasoned:** type `echo A\\\\B-A\\\B-A\\B` and read what lands. On this
setup the answer was `A\\B-A\\B-A\B` — **four backslashes in the host string produce two on the
guest.** Do this once per session; it is two seconds and it tells you the exact multiplier for your
shell.

### And one that IS in our own notes and was walked into anyway

**A `.ps1` written UTF-8 without a BOM breaks Windows PowerShell 5.1.** An em dash decodes to a
character that terminates a string, and the parser then fails on an unrelated closing brace many
lines later — the error points nowhere near the cause. This is already recorded under
`powershell-51-encoding-traps`, and it still cost a cycle.

**Check:** every script written for a VM is **pure ASCII**. Verify it, do not trust it:

    node -e "const b=require('fs').readFileSync('x.ps1');console.log([...b].filter(c=>c>127).length)"

Zero, or fix it before copying.

### The general lesson, which is why this section exists at all

The host and the guest disagreed about **what characters were sent**, **what a path meant**, and
**what encoding a file was in** — and every one of those disagreements produced a plausible,
specific, wrong error message pointing somewhere else. A session that trusts its own instruments
here will spend hours reading correct output about the wrong thing.

**Canary first, then drive.** One `echo` of known text, one backslash-count test, one ASCII check.

---

## BUG-141 — the suite-under-load stall: instruments, and what each one can and cannot see

Five files, added 2026-09-09 while root-causing [[BUG-141]]. They exist because a
20-second test timeout tells you a test did not finish and **nothing about where it was
stopped**, and every hypothesis in that entry — fsync, a lock, a leaked handle, module
loading — produces the identical symptom.

| file | what it does |
|---|---|
| `bug141-instrument.setup.ts` | vitest `setupFiles` hook. Per test: wall time, CPU, worst event-loop delay, and a 3 s/8 s/15 s watchdog that dumps in-flight libuv **requests** and the module ids the worker is **resolving**. Inert unless `BUG141_LOG` is set. |
| `vitest.bug141.config.ts` | the real config plus that setup file. Same include, same environment, **same 20 s `testTimeout`** — raising it would hide the thing being measured. |
| `bug141-loop.mjs` | runs the full suite N times, one at a time, recording exit code and wall clock per run. |
| `bug141-load.mjs` | runs K full suites CONCURRENTLY, R rounds. This is what reproduces the stall; one suite at a time on an idle machine does not. |
| `bug141-analyze.mjs` | reads every record and prints the duration tail, the slowest tests, first-test-in-file vs the rest, every stall record, and the target file's phase split. |
| `bug141-fsync-probe2.mjs` | the filesystem probe, at genuine cross-process concurrency (see below). |
| `bug141-controls/` | proves the instrument can FIRE. Run before trusting any silence it reports. |

Run the controls first, always:

```bash
BUG141_SLOW_TRANSFORM=1 BUG141_LOG=/tmp/ctl node node_modules/vitest/vitest.mjs run --config vitest.bug141-controls.config.ts
```

Then a reproduction:

```bash
node scripts/verification/bug141-load.mjs 4 3 .bug141-load && node scripts/verification/bug141-analyze.mjs .bug141-load
```

### The three instruments that were WRONG before they were right

Recorded because each of them read as a clean result while measuring nothing, and each
was caught only by deliberately trying to make it fail.

1. **Buffered records, flushed on `process.on('exit')`.** The self-test showed records
   silently missing: vitest's forks pool does not exit workers cleanly enough for that
   handler. The flush moved to a per-file `afterAll`. Had this not been checked, every
   "no stall was recorded" would have been unfalsifiable.
2. **`process.cpuUsage()` as a millisecond figure.** On this machine it under-reports by
   roughly 25x — 782 ms of pure arithmetic measured as 31 "cpuMs". It still separates
   *busy* from *idle* (an idle sleep reads exactly 0), so it is used only for that, never
   as a duration. `performance.eventLoopUtilization()` was tried as a replacement and is
   worse here: it reads 0.000 for a synchronous block, because it only accounts at loop
   boundaries.
3. **A pending-delete probe** that timed how long a deleted file's NAME stayed in
   `readdir`, on the theory that a scanner's open handle would keep it listed. **The
   positive control failed**: Node on Windows 10+ deletes with POSIX semantics, so the
   name vanishes immediately even with a handle deliberately held open. It reported a
   clean 0 across 960 samples while being structurally incapable of reporting anything
   else. Removed, not reported. The observable signature of a third party holding a
   handle on Windows is **`ENOTEMPTY` from `rmdir`**, not a lingering name.

### The concurrency flaw in the ORIGINAL fsync probe

`bug141-fsync-probe.mjs` (2026-08-31) runs its "15 workers" as 15 `Promise.all` branches
**inside one node process**. `fs.promises` calls are served by the libuv threadpool,
which defaults to **four threads** — so at most 4 filesystem operations were ever in
flight, not 15. The suite runs ~300 separate worker *processes* (measured: 303 processes
for 409 files), each with its own pool. Corrected in `bug141-fsync-probe2.mjs`, which
forks real processes; on the same machine the worst atomic write went from **28 ms to
1319 ms** under load. The old number was not wrong, it was measuring a tenth of the load.

### What `resolving[]` means, exactly

It is vitest's own set of module ids the worker is currently fetching/transforming.
Controls establish its range:

- stall inside a module **transform** → the module is named ✅
- stall inside a module **evaluation** (top-level await) → **empty** ⚠ a real limit
- stall on a plain timer → empty ✅

So a non-empty `resolving[]` is strong evidence; an empty one only rules out the
transform half.

### Testing a retry wrapper in ESM: the spy that cannot intercept

Recorded because the symptom is a **passing test**, and anyone writing a retry, a backoff or a
fallback in this codebase will hit it.

`writeJsonAtomicDurable` was first written inside `atomic-write.ts`, right next to the
`writeJsonAtomic` it wraps. The retry test spied on the module object and made the writer fail
once:

```ts
vi.spyOn(await import('../atomic-write'), 'writeJsonAtomic').mockImplementation(...)
```

It went green with `calls === 0`. **An ESM module calling its own export calls the local binding
directly** — the spy replaces the property on the module namespace object, which nothing inside
that module ever reads. The retry was never exercised; the assertion that it had been retried
simply never ran against anything.

**The fix is architectural, not a mocking trick:** move the wrapper into its own module so the call
crosses a module boundary that `vi.mock` can actually hold (`src/main/durable-write.ts` imports
`writeJsonAtomic` from `./atomic-write`). That is also the better shape — a retry policy is a
separate concern from an atomic write.

**The general check:** after writing any test that asserts *"the inner thing was called N times"*,
assert the count is what you expect **including the zero case**. `expect(calls).toBe(2)` catches
this; `expect(ok).toBe(true)` does not.

### A register is a claim about a document, and it decays faster than the document

The taxonomy's own **numbering register** — the one paragraph in that file whose entire job is to
be trusted about numbers — read *"Canonical count: 88 species, numbers run 1 to 89"* while the file
held definitions up to **101**. Twelve species past its own claim.

It decayed faster than the document around it for a structural reason: **people re-read prose and
re-derive counts only when they need them.** Every session that added a species read the species
list; none re-read the register, because a count feels like a fact rather than a claim. That is
species 18 (the stale doc in the privileged position) landing on the catalogue's own index, and it
is the sharpest instance of the catalogue's thesis in the catalogue itself.

**The rule:** never quote a count, a total, or a range from prose. Recompute it, in one command,
at the moment you need it:

    grep -oE '^\*\*[0-9]+\. ' '<file>' | grep -oE '[0-9]+' | sort -n | uniq -c

### A fix that makes a check green by removing what the check was reading

`tracker-status.mjs` refused to write: three entries had "no status line directly under the
heading". The cause was that another session had rolled out a readiness field —
`**Status:** OPEN · 2026-09-09 · READY — …` — across **36 entries**, and the validator's pattern
did not allow the extra token.

The first fix was a regex that normalised all 36 back to the older shape. **It worked, the gate went
green, and no readable information was lost** — `READY` just moved after the em dash. It was still
wrong: the check passed because *the field it reads had been deleted*. A colleague's
machine-readable token became prose to satisfy a tool that did not know about it yet.

Reverted; the validator was widened to accept and preserve the token, and their 37 lines restored.

**The question is not "did the check pass" but "does the check still have the same thing to look
at".** Deleting a test, loosening an assertion, dropping a field, widening a type to `unknown`,
catching the exception the check existed to surface — all pass, all by reducing what is checked.
**And when two parties disagree about a shared schema, widen the validator rather than rewrite the
other party's data** — the validator is one file with one author; their entries are 36 and someone
else's intent. Now taxonomy species 104.

### An instrument whose load scales with the arm it is timing

`bug141-fanout-probe.mjs` compares an unbounded directory read against a bounded one, and — to show
the fairness cost — issues a small unrelated write every 5 ms **for the duration of each arm**.

That sampler is the measurement's own confound. The slower arm runs longer, so it is charged for
more sampler writes, so it looks even slower... except here it ran the other way and made **bounding
look FASTER than unbounded**, which is backwards. That result was reported to the founder and
written into a bug entry and eight code comments before a repeat with no sampler showed the truth:
unbounded reads a directory in 11 ms, bounded-16 in 17 ms. Bounding is a **trade**, not a free win.

#### FIRES ≠ NEUTRAL, and this project has only ever validated the first half

This is the sharper version, and it is a gap in how **every** instrument here has been checked —
including the ones that worked.

The standing discipline is *"prove the check can FAIL before trusting that it passes"*: break the
thing on purpose, watch it go red, restore. Four instruments in this investigation were caught that
way. **That question is "can it fire?"** The sampler passed it easily — it fired every time, and its
numbers were real.

**"Does it distort what it measures?" is a different question, and nothing in the checklist asked
it.** The sampler's cost was proportional to the duration it was timing, so it did not fail, it
*leaned* — and it leaned hard enough to invert the result and produce a confident, wrong claim that
reached the tracker, the memory and eight code comments before a sampler-free repeat caught it.

Two checks, not one, for anything you measure with:

1. **Can it fire?** Break the subject; the instrument must go red. (Positive control.)
2. **Is it neutral?** Measure the headline number with the instrument OFF, and only then turn it on
   for the secondary effect. If the instrument's cost scales with what it is timing, it cannot
   compare durations at all — it can only measure the secondary thing it was added for.

A silent instrument is caught by (1). A **biased** one passes (1) and is caught only by (2).

**The check:** measure the headline number with the instrumentation OFF, and only then turn it on to
measure the secondary effect. If an instrument's cost is proportional to the duration it is
measuring, it cannot be trusted to compare durations. Same family as a benchmark that includes its
own logging, and it is easy to miss because the instrument is the part you trust.
