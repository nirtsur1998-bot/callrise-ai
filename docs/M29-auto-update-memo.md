# Decision memo — auto-update default (the other half of release safety)

**Status:** DECISION MEMO with a specific recommendation. Nothing built.
**Date:** 2026-08-23.

---

## The situation in three sentences

Staged rollout lets us **halt** a bad version before it reaches everyone
(verified, zero code). But auto-update is **off by default**
(`src/main/app-settings.ts:742`, introduced `6c8515e` on 2026-08-06 with no
recorded reason beyond caution), so a *fix* reaches only the people who open
Settings → App and click "Check for updates." The consent-leak hotfixes
1.2.5 and 1.2.6 are the concrete case: **any install on 1.2.4 or older
whose user never clicked that button still has the leak today.** Our
privacy promise currently depends on users remembering a button.

## What "on" actually does (already built, behind the toggle)

When the toggle is on (`updater/index.ts:28-35,279-296`): a check 30 s after
launch and every 6 h; `latest.yml` is validated by our default-deny gate
(`policy.ts`) before anything downloads; the download runs as a visible
Activity Center job; the install happens on the app's **next natural quit**
— never mid-session, never mid-call. The manual Check / Download / Restart
buttons keep working regardless. The founder's own machine has it on.

## What a check sends, honestly

One HTTPS request to `github.com` for the release list and one for
`latest.yml`. GitHub sees the IP address and an `x-user-staging-id` header
carrying the random `.updaterId` UUID (electron-updater adds it for servers
that do server-side staging; GitHub ignores it). **No account information,
no content, nothing from the user's data.** We can blank that header with
one line (`autoUpdater.requestHeaders = { 'x-user-staging-id': '' }` — our
headers are applied last, `AppUpdater.js:333-338`; the staging decision is
made locally from the file, so rollout still works). The brand sentence
stays true; the honest expansion is: *"CallRise contacts GitHub to check for
updates. It never sends your data."*

## The real choice

"Keep it off and rely on a prominent in-app prompt" is not actually an
option: a prompt needs a background check to know there is something to
prompt about. So the choices are:

| | **C. Today** | **A. Check + prompt by default** | **B. Full auto by default** |
|---|---|---|---|
| Background network request | none | yes (same disclosure as B) | yes |
| User sees an update exists | only if they open Settings → App | in-app card on launch: "1.4.0 is ready — what's new — Update / Later" | same card, but the download is already done |
| Fix reaches a user who never touches Settings | **never** | when they click the card | on their next quit, with no click |
| Fix reaches a user who never quits the app (laptop always-on) | never | when they click | on their next quit — so add "Restart to update" in the card |
| Blast radius of a bad release | n/a | limited by staged % and by the click | limited by staged % (this is why A4's rollout matters *more* under B) |
| Privacy surface | none | IP + blankable UUID, every 6 h | same as A |
| What we can say | "We never contact anyone unless you ask" | "We check for updates; you choose when to install" | "We keep you current; turn it off anytime" |
| Consent honesty | n/a | one line in onboarding + Settings | same, plus the toggle stays |

## Recommendation: **B — full auto by default**, with four conditions

**Why B over A:** the difference between A and B is exactly the users who
don't click — and those are the users a privacy fix most needs to reach.
Option A still leaves the promise resting on a button; B rests it on the
next quit. Every mainstream desktop app (Chrome, VS Code, Slack, Zoom) made
this call for the same reason. The privacy cost of B over A is **zero**
(identical network behaviour); the only difference is who presses install.

**Why not stay at C:** it is the one setting that makes our own hotfixes
optional.

**The four conditions that make B honest:**

1. **Tell them, once, in plain words.** An onboarding step (B3) and the
   Settings description, both saying: *"CallRise checks GitHub for updates
   every few hours and installs them when you quit. Updates are how privacy
   and security fixes reach you. It never sends your data — just the request.
   You can turn this off below."* The existing toggle stays and still means
   what it says.
2. **Blank the staging header** (one line) so the request carries nothing
   stable about the install. Disclose what remains (the IP).
3. **Never install mid-session.** Already true (install on quit). Add the
   "Restart to update" card (B5) so an always-on laptop isn't silently stale
   for weeks — the card, not a forced restart.
4. **Ship under staged rollout.** Under B, the rollout percentage is the
   *only* thing between a bad build and every install that quits tonight.
   That makes the runbook's draft-release CI change (zero-window) a
   prerequisite for flipping the default, not an optional polish. Order:
   A4 CI change verified on a throwaway tag → then flip the default.

**Migration for existing installs:** the settings file stores the whole
object, so every existing install has `autoUpdateEnabled: false` written to
disk; changing the code default reaches **nobody** by itself. Proposed: a
new `updatePolicy: 'auto' | 'prompt' | 'manual'` key; on first launch
without it, set `'auto'` and show a one-time dismissible notice ("We now
keep CallRise up to date automatically — here's why — turn it off here").
That overrides anyone who deliberately turned the old toggle off; with
today's install base that is at most a handful of people, and the notice
makes it visible and reversible in one click. If the founder would rather
never override an explicit choice: apply `'auto'` only when the old key was
*absent* — but that reaches zero existing users, so it only helps future
installs.

**Offline grace / failure mode:** a failed check is inert (status →
`error`, no retry storm — `updater/index.ts:281-285`). An install outside the
staged cohort sees nothing. A bad signature/hash is refused by the gate and,
with A1, recorded as a health counter.

## If the founder chooses A instead

Everything above minus the auto-download and auto-install; the card says
"Update now." Still requires conditions 1, 2 and 4. The manual runbook
becomes the primary push mechanism, and I'd add "send the founder a nudge
when a version's card has been dismissed 3× without updating" to A2 so we
at least know who is stuck.

## Decisions

| # | Question | Lean |
|---|---|---|
| 1 | Default: C / A / **B** | B |
| 2 | Migration: override stored `false` with a notice, or only new installs | override with notice |
| 3 | Blank the staging header | yes |
| 4 | Sequence: A4 zero-window CI → flip default | yes — the CI change first |
