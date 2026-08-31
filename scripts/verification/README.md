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
