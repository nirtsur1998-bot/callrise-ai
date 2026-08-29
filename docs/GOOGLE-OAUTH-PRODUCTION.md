# Google Calendar for all users — what "publish it properly" actually takes

**Written 2026-08-29**, after Google Calendar connect failed with
`Error 403: access_denied` — *"CallRise-Ai has not completed the Google
verification process. The app is currently being tested, and can only be
accessed by developer-approved testers."*

**Goal (founder's words):** *"I want it to work for all users without the need
to add [test users]."*

---

## 0. The correction that saves a wasted afternoon

**Creating a new Google account and a new Cloud project does not help.**

Every OAuth client Google issues — on any account, in any project, created
today or in a year — starts with its consent screen in **Testing** status,
which allows only explicitly-added test users. A from-scratch setup lands on
the *identical* 403 screen. The account is not what's blocking this; the
**publishing status** is.

It would also repeat a known injury: commit `9f8f1b9` (2026-08-05) swapped the
bundled client to a new project, and because the new client was left in
Testing, Google Calendar has been unconnectable for every install since. A
second swap re-breaks every existing install for the same reason.

**The existing client is fine.** Verified rather than assumed: the exact
auth URL `google.ts` builds was replayed against Google twice and reached the
sign-in page cleanly — no malformed request, no `redirect_uri_mismatch`. A
`http://127.0.0.1:<port>` redirect is only accepted for a **Desktop app**
client type, so the registration type is already correct too. The one wrong
thing is the publishing status.

---

## 1. There are two levels, and only one of them is instant

### Level 1 — Publish to Production, unverified (today, ~2 minutes)

Cloud Console → APIs & Services → OAuth consent screen → **Publish app**.

- Removes the test-user allowlist **immediately**. Any Google account can
  connect.
- Users see an **"Google hasn't verified this app"** interstitial and must
  click *Advanced → Go to CallRise AI (unsafe)* to continue.
- Unverified apps using sensitive scopes are subject to a **user cap**
  (100-user scale), so this is fine for you, testers, and early users — not
  for a public launch.

This is the step that unblocks cases 1 and 3 of the reminder verification
today, and it needs no domain and no code change.

### Level 2 — Verified (removes the warning and the cap)

This is a Google **review**, not a setting. Turnaround is typically days to
several weeks.

Good news first: `calendar.readonly` and `calendar.events` are **sensitive**
scopes, not *restricted* ones. Restricted scopes (Gmail-, Drive-class) require
an annual third-party security assessment costing real money. **We do not need
that.**

Requirements, all of which Google checks:

| # | Requirement | Status today |
|---|---|---|
| 1 | App homepage on a domain you own | ❌ **missing** — `callrise.ai` does not resolve (NXDOMAIN) |
| 2 | Privacy policy hosted on that same domain | ❌ missing (draft below) |
| 3 | Domain ownership verified in Google Search Console | ❌ blocked on #1 |
| 4 | App name + logo consistent with the homepage | ⚠️ logo exists in-app; not published |
| 5 | Demo video showing the OAuth flow and each scope in use | ❌ missing (shot list below) |
| 6 | Written justification per scope | ❌ missing (drafted below) |
| 7 | Submitted for verification from the Cloud Console | ❌ not submitted |

**The blocking item is #1.** Everything else is writing and recording, which
can be prepared in parallel — but nothing can be *submitted* until a domain
exists and is verified.

---

## 2. Who does what

I cannot, and will not:

- **Create a Google account** or sign in as you.
- **Submit the verification** — it is an action taken as you, accepting
  Google's terms on your behalf.
- Buy or configure a domain.

You do those. What I can do, and will, once you decide:

- Write the privacy policy and homepage copy (drafted below).
- Write the scope justifications (drafted below).
- Write the demo-video shot list (below).
- Verify the technical OAuth config and wire any new client into the code.
- Re-verify reminder cases 1 and 3 end to end the moment Google connects.

---

## 3. Scope justification (draft — for the verification form)

> **`https://www.googleapis.com/auth/calendar.readonly`**
> CallRise AI is a desktop sales assistant. It reads the user's calendar to
> show their upcoming meetings inside the app, to detect that a meeting is
> currently running so a call recording can be associated with it, and to
> generate a pre-meeting brief from the user's own CRM notes. Read access is
> required because the app displays a calendar view and matches live calls to
> scheduled meetings. No calendar data leaves the user's device except to the
> Google account it came from.

> **`https://www.googleapis.com/auth/calendar.events`**
> Requested only when the user explicitly enables two-way sync. It lets the
> user create, edit and delete their own meetings from inside CallRise AI, and
> writes reminder lead times so Google fires the user's reminders. It is not
> requested at initial connect — the app has a separate read-only mode, and
> the user opts into write access as a distinct action.

Both are honest descriptions of what the code does today. The read-only-first
design is a genuine strength in a verification review: it shows least
privilege by default.

---

## 4. Privacy policy — what it must actually say

Google checks that the policy covers the Google user data specifically. It
must state, at minimum:

- What Google data is accessed (calendar events: titles, times, attendees).
- Why (display, meeting detection, prep briefs, optional two-way sync).
- Where it is stored — for CallRise AI: **on the user's own device**, with
  cloud backup only if the user turns it on.
- That it is **not** sold, and not used for advertising or training.
- How a user revokes access (Disconnect in-app, or their Google account's
  third-party access page).
- A contact address.

I can write the full text once you confirm the domain and the contact address
— it should not be generic boilerplate, because the honest version here is
unusually good (local-first, opt-in cloud, no training).

---

## 5. Demo video — shot list

Google wants to see the real flow, unedited, in the real app:

1. The app's Calendar screen with nothing connected.
2. Clicking **Connect Google Calendar**; the consent screen showing the app
   name and the requested scopes.
3. Granting consent; returning to the app; meetings appearing.
4. Enabling **two-way sync**, showing the second consent for
   `calendar.events`.
5. Creating an event in the app and showing it appear in Google Calendar.
6. Clicking **Disconnect**, showing access is revoked.

Screen recording, no narration required, under ~5 minutes.

---

## 6. Recommended order

1. **Publish to Production now** (Level 1). Unblocks you today; costs nothing;
   reversible.
2. Decide the domain. Point it somewhere trivial to start — a single static
   page is enough for homepage + privacy policy.
3. Verify the domain in Google Search Console.
4. I write the privacy policy and homepage copy; you publish them.
5. Record the demo video (I have the shot list; the app is already in a state
   where every step works, except Google connect itself — do this after step 1).
6. Submit for verification. Expect follow-up questions from Google's reviewer.

**Do not** create a new Google account or Cloud project for this. It changes
nothing about the requirements above, and it breaks every existing install
again.

---

## 7. Open question for the founder

**Do you own a domain, or want to register one?** Nothing in the verification
path can be submitted without it. `callrise.ai` currently does not resolve
(NXDOMAIN), so if it isn't registered yet, that is step zero.

*(An earlier draft of this doc also flagged `updates.callrise.ai` as a dead
update feed. That was wrong and is corrected here: the string appears only in
`updater/__tests__/` fixtures. The real feed comes from `UPDATE_FEED_URL` at
runtime and defaults to unset, so nothing in production points at that host.)*
