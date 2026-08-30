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
