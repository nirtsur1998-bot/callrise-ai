# Known issues found during M40 — repo-level, not Mac-specific

Found on the Mac during M40, but **none of these are macOS bugs**. They are
platform-independent and apply equally to the Windows machine. Filed here so the
Windows session can pick up the routing fix, which is theirs.

---

## 1. PRODUCT — the sidebar "Calls" does nothing while a call is open

**Severity: moderate. A navigation control that silently does nothing.**
**Not a trap** — there is a working exit, see below.

Open any saved call (Calls → Past → a row). Then click **Calls** in the sidebar.

Nothing happens. Not a slow transition, not a wrong destination — **no change at
all.** Measured twice, from two independent probes:

```
sidebar "Calls"   clicked (matches=1)
  page-text hash a3b8be7196e8 -> a3b8be7196e8   changed=false   stillOnDetail=true
```

The hash is of the page's full rendered text, compared before and after, so this
asserts a **change** rather than a target state — a control that had worked would
be unmissable.

### What does work

| route | result |
|---|---|
| **"Past Calls" link** (on the detail page) | **works** — hash changes, detail-only controls disappear |
| sidebar "Calls" | **no-op** |
| a "Back" control | **does not exist** on a call detail page |
| sidebar Home / Pipeline / Coaching | **NOT ESTABLISHED** — see below |

**The founder recognised this shape immediately:** *"I hit something in this
family months ago — the sidebar Calls button not leaving a detail page while the
Past Calls back link did."* So it is **recurring**, not new.

### What I did NOT establish

Whether the **other** sidebar items (Home, Pipeline, Coaching) navigate correctly
from an open call. My probe could not re-enter the detail page reliably between
attempts, and rather than report numbers from a harness I could not trust, the
rows are omitted. **That is the open question for whoever fixes this**, and it is
the one that decides severity: if only `Calls` is dead it is a targeted routing
bug; if the whole sidebar is inert from a detail page, a user really is stuck
with one exit.

### Why it matters beyond the annoyance

It silently disabled an instrument for months — see issue 2.

---

## 2. INSTRUMENT — `screen-sweep.mjs` has never swept the call-detail screens, on any platform

**This is the one to carry to the Windows machine.** Every clean sweep this
project has reported, on either OS, was skipping the call-detail states while
appearing to account for them.

Two independent causes, both now fixed:

**(a) The sweep never clicked "Past".** The Calls screen opens on its **Live**
tab; saved calls live on **Past**; and the rows the next steps look for (`Call ·`
prefix) exist only there. The word `Past` appeared **nowhere** in the file.

**(b) It then tried to return to the list via the sidebar "Calls"** — issue 1 —
so it never left the first call, and the single element matching `Call ·` was
that page's own title.

### The part that let it survive

It never failed loudly. It reported:

```
SKIP Call detail (newest)   — only 0 rows
SKIP Call detail (4th)      — only 0 rows
```

which reads as *"this profile has no calls."* **That is a claim about the
population when the cause was the instrument**, and it held up for as long as it
did because nobody had run the sweep against a **populated** profile — on an
empty one the message is simply true. The summary line then counted both as
deliberate skips, so the sweep looked complete.

Same species as the inert brain and the disclosure with no counter: a
well-behaved message that looks like information and is an absence of capability.

### Proven, not inferred

With a synthetic sandbox seeded through the app's own IPC:

```
calls.list() -> 3, later 6
clicking "Past" -> "Past Calls / 3 calls", all rendered, date-bucketed,
                   with durations and speaker counts
```

### Result

```
before:  24 states visited, 3 skipped   (both call-detail states skipped)
after:   26 states visited, 1 skipped   (only "Background jobs" remains)
```

Both call-detail screens report **0 defects, 0 console errors** — and that is the
**first automated visual coverage those screens have ever had, on any platform.**

The remaining skip, `Background jobs — matched 0 for "Background jobs"`, is a
different and still-unexamined cause.

---

## 3. REPO — a clean `npm install` does not produce a working Electron

Written up in full in [`README.md`](../README.md#-npm-install-may-leave-you-with-no-electron-binary--and-the-error-blames-the-wrong-thing).
Summarised here because it is repo-level and the Windows machine will hit it on
its next clean install: npm 11 gates lifecycle scripts, so `npm install` exits 0
without downloading Electron's binary and the launch fails with a misleading
"corrupt install" error. The tell is a missing `node_modules/electron/path.txt`.

The second-order failure matters more: the same gate blocks
`electron-builder install-app-deps`, leaving `better-sqlite3`, `active-win` and
`sharp` built for system Node instead of Electron's ABI — the silent-never-loads
failure `CLAUDE.md` already documents for the detection addons, arriving through
a door nobody was watching.

---

## 4. TEST — three suites fail on macOS; at least one is genuinely platform-dependent

> ### RESOLVED 2026-09-18 — it was the Node version, not the platform
>
> The full suite on this Mac reported **14 files / 79 tests failed**, eleven of them dying
> identically at `localStorage.clear()`. Proven both directions on one file, one machine:
>
> ```
> Node 26.4.0 (this Mac)          →  4 failed
> Node 22.23.2 (npx -y node@22)   →  4 passed
> ```
>
> Node ≥ 25 ships its own `localStorage` global, default-on, which vitest's DOM environment does
> not replace — so a bare `localStorage` in a test resolves to Node's unconfigured stub, not
> happy-dom's. `sessionStorage` is untouched, which is the tell. **CI pins Node 22**, where the global
> did not exist yet. So the escalation ("are these red on Windows too?") answers itself: **not if
> Windows runs Node 22**, and nothing here suggests otherwise.
>
> Nothing had pinned the Node version, which is how a machine drifted onto 26 with no message naming
> the cause. Now: `.nvmrc` + `package.json#engines` say `22.x`, and a setup-file guard
> (`src/__tests__/setup/node-webstorage-guard.ts`) turns the seventy-nine failures into **one** that
> names the fix. Red/green/quiet all verified (`19827f8`).
>
> Of the original three: `tier1-diagnostics` was the genuinely Mac-only one (Windows path
> separators) and is fixed (`2459f36`); `Tier1SettingsCard` and `recorder.tier1` were this.
>
> **The full suite under Node 22 on macOS, read from the suite's own summary lines, real exit 0:**
>
> ```
> Test Files  468 passed | 3 skipped (471)
>      Tests  4517 passed | 15 skipped (4532)
> ```
>
> No failing files, no stray `Errors` line. **There are no macOS-specific test failures left.**
>
> One more of the 14 was **mine** — `no-false-locality-claims` correctly flagged the Intel-refusal
> copy's "on this Mac" as a locality-claim detector hit. Accounted for with a reason, not reworded
> (`9222f67`); the entry says plainly it is not yet founder-approved.

*The original entry, kept for the record:*

`verify-green.mjs` reports `NOT GREEN` on macOS. Run individually:

| suite | result on macOS |
|---|---|
| `tier1-diagnostics.test.ts` | 2 failed / 6 passed — **hardcodes Windows backslash separators** that `path.join` cannot produce on macOS. Genuinely Mac-only. |
| `Tier1SettingsCard.test.ts` | 12 failed (all) — `localStorage` undefined despite `happy-dom` loading |
| `recorder.tier1.test.ts` | 22 failed (all) — same shape |

The latter two are **not obviously Mac-specific**: `localStorage` being undefined
is platform-independent, `happy-dom` 20.11.2 is installed and matches the
lockfile (no drift — `package-lock.json` is unmodified), and the files do declare
`// @vitest-environment happy-dom`. **Open question for the Windows machine: are
these three red there too?** If they are, `verify-green` has not been green on
either platform and that is worth knowing before a release gate depends on it.

Separately, some full-suite failures do **not** reproduce when a file is run
alone (`calls-fs.app-version.test.ts` passes 14/14 solo), which is BUG-141's
documented concurrency shape rather than a platform issue.

---

## 5. PRODUCT — a sidebar RECENT row for a call that no longer exists does nothing

**Severity: low on its own. Filed because it is the third stale-list symptom in
one region — see the note to the Windows session below.**
**For the Windows session.** Found on macOS on 2026-09-18, but nothing in the
path is platform-specific.

**Observed, twice.** The sandbox profile inherited `salesos.recentlyViewed` from
the founder's real profile, so its RECENT rows name calls (`Call · Aug 6, 2026,
5:42 AM`, …) that do not exist in the sandbox. Clicking one highlights the row;
the main view stays exactly where it was (screenshot: `call-detail-dark.png` in
the first tour run — Past Calls list still showing, sidebar row selected). No
error, no toast, no console message (screen-sweep's console probe was armed on
the same profile: 0), and the stale row is not removed, so it does the same thing
next time.

**Code path, as far as read (not stepped through):** `Sidebar.onSelectRecent` →
`recentTarget(item)` (a pure function, `features/navigation/recentTarget.ts`,
which fixed the earlier "every call row went to the same screen" bug) →
`MainApp.openRecent` → the calls screen with the id as its one-shot preselect.
The calls screen can only select an id that is in its loaded list; a missing id
selects nothing and the list stays. Nothing along that path checks that the
record exists, and nothing prunes `recentlyViewed` when a call, contact or deal
is deleted — `recentlyViewed.ts` has no remove-by-id caller outside its own
ring-buffer logic (grep'd, not proven).

**A user hits this by deleting a call** — the 6-second-undo delete leaves the
RECENT row behind. Same for contacts and deals, presumably (not tested).

**Why this is routed rather than fixed here (founder, 2026-09-18):** it is the
third symptom in the same region — (1) the sidebar "Calls" no-op from an open
call (§1 above), (2) the recovered-call delay/no-title (`BUG-230`, M37), and
(3) this. "Three in one region suggests one cause." The common thread I can see
without stepping through is that navigation and the record stores agree on ids
but never on *existence* — each screen trusts whatever id it is handed. That is a
hypothesis, not a finding; the Windows session has the M37 context to test it.

**Not established:** whether contacts/deals behave the same; whether the
command palette's recent rows (a separate list — `CommandPalette.tsx`) share
the symptom; what a user *should* see (open the list with a "that call was
deleted" note, or drop the row).

**Assessed by the Windows session, 2026-09-18 — tracker numbers `BUG-286` (§1) and
`BUG-287` (this).** Both reproduce on Windows; neither is macOS-specific. Corrections to the
above: (1) the "one cause" hypothesis is **wrong** — every path *does* check the record exists;
none of them *reports* it (calls bounce out of the detail silently, contacts resolve through a
`.find()` over the loaded list, nothing prunes the trail). The fix is a response, not an existence
check. (2) `BUG-230` is not in this family (no id, no lookup, no navigation) — dropped from the
grouping. (3) The command palette is **not** a separate list: it renders the same trail
(`CommandPalette.tsx:203`, `:272`), so it has this symptom too. (4) §1 is targeted, not a trap:
from an open call detail, Home / Pipeline / Coaching all navigate; only the sidebar item for the
screen you are already on is dead — and Pipeline does the same from a contact detail.
