# Verification tooling — read this before driving the app

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
